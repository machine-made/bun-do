// Test helpers: start a real bun-do server on a free port with its own data directory.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export const ROOT = join(import.meta.dir, "..");

export interface TestServer {
  port: number;
  base: string;
  dataDir: string;
  stop: () => void;
}

/** Start server.ts with an empty task list unless `tasks` is given. */
export async function startServer(
  options: {
    tasks?: unknown;
    projects?: unknown;
    rawTasks?: string;
    rawProjects?: string;
    env?: Record<string, string>;
    dataDir?: string;
  } = {},
): Promise<TestServer> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "bun-do-test-"));
  if (options.rawTasks !== undefined) {
    writeFileSync(join(dataDir, "tasks.json"), options.rawTasks);
  } else if (!existsSync(join(dataDir, "tasks.json"))) {
    writeFileSync(join(dataDir, "tasks.json"), JSON.stringify(options.tasks ?? []));
  }
  if (options.rawProjects !== undefined) {
    writeFileSync(join(dataDir, "projects.json"), options.rawProjects);
  } else if (!existsSync(join(dataDir, "projects.json"))) {
    writeFileSync(join(dataDir, "projects.json"), JSON.stringify(options.projects ?? []));
  }
  const proc = Bun.spawn(["bun", join(ROOT, "server.ts"), "--port=0"], {
    env: { ...process.env, BUNDO_DATA_DIR: dataDir, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const port = await readPort(proc.stdout);
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    dataDir,
    stop: () => {
      proc.kill();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function readPort(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
    const match = text.match(/listening on http:\/\/localhost:(\d+)/);
    if (match) {
      reader.releaseLock();
      return Number(match[1]);
    }
  }
  throw new Error(`server did not start; output so far: ${text}`);
}

/** Send a JSON request and return the status and parsed body. */
export async function api(
  server: TestServer,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(server.base + path, {
    method,
    headers: { ...(body !== undefined && { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed };
}

/** The calendar date (YYYY-MM-DD) in a time zone, as the server should see it. */
export function localDate(timeZone: string, offsetDays = 0): string {
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

/** A free TCP port on 127.0.0.1. */
export function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  return port;
}
