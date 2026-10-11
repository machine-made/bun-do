import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { freePort, ROOT } from "./helpers";

const dataDir = mkdtempSync(join(tmpdir(), "bun-do-cli-"));
const port = freePort();

function cli(...args: string[]): { code: number; out: string } {
  const res = Bun.spawnSync(["bun", join(ROOT, "cli.ts"), ...args], {
    env: { ...process.env, BUNDO_DATA_DIR: dataDir },
  });
  return { code: res.exitCode, out: res.stdout.toString() + res.stderr.toString() };
}

afterAll(() => {
  cli("stop");
  rmSync(dataDir, { recursive: true, force: true });
});

describe("cli", () => {
  test("--version prints the package version", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    expect(cli("--version").out.trim()).toBe(pkg.version);
  });

  test("start, status and stop manage one background server", async () => {
    const started = cli("start", `--port=${port}`);
    expect(started.out).toContain("started");
    expect(existsSync(join(dataDir, "bun-do.pid"))).toBe(true);

    const res = await fetch(`http://127.0.0.1:${port}/api/tasks`);
    expect(res.status).toBe(200);

    expect(cli("start", `--port=${port}`).out).toContain("already running");
    expect(cli("status").out).toContain("running (pid");

    expect(cli("stop").out).toContain("stopped");
    expect(existsSync(join(dataDir, "bun-do.pid"))).toBe(false);
    expect(cli("status").out).toContain("not running");
  });

  test("backups command lists backup files without a running server sorted newest first", () => {
    const bdir = join(dataDir, "backups");
    mkdirSync(bdir, { recursive: true });
    writeFileSync(join(bdir, "tasks-2026-01-02.json"), JSON.stringify([{ id: "1", title: "Task 1" }]));
    writeFileSync(join(bdir, "projects-2026-01-03.json"), JSON.stringify([{ id: "p1", name: "Proj 1" }]));
    writeFileSync(join(bdir, "tasks-2026-01-05.json"), JSON.stringify([{ id: "2", title: "Task 2" }]));

    const res = cli("backups");
    expect(res.code).toBe(0);
    const idx05 = res.out.indexOf("tasks-2026-01-05.json");
    const idx03 = res.out.indexOf("projects-2026-01-03.json");
    const idx02 = res.out.indexOf("tasks-2026-01-02.json");
    expect(idx05).toBeGreaterThanOrEqual(0);
    expect(idx03).toBeGreaterThan(idx05);
    expect(idx02).toBeGreaterThan(idx03);
  });

  test("restore command can restore oldest backup even at retention limit", () => {
    const bdir = join(dataDir, "backups");
    mkdirSync(bdir, { recursive: true });
    writeFileSync(join(dataDir, "tasks.json"), JSON.stringify([{ id: "curr", title: "Current" }]));
    writeFileSync(join(bdir, "tasks-2026-01-01.json"), JSON.stringify([{ id: "old1", title: "Oldest Task" }]));
    writeFileSync(join(bdir, "tasks-2026-01-02.json"), JSON.stringify([{ id: "old2", title: "Middle Task" }]));

    // Run restore with BUNDO_BACKUP_KEEP=2 restoring the oldest file
    const res = Bun.spawnSync(["bun", join(ROOT, "cli.ts"), "restore", "tasks-2026-01-01.json"], {
      env: { ...process.env, BUNDO_DATA_DIR: dataDir, BUNDO_BACKUP_KEEP: "2" },
    });
    expect(res.exitCode).toBe(0);
    expect(readFileSync(join(dataDir, "tasks.json"), "utf-8")).toContain("Oldest Task");
  });

  test("restore command without running server restores on files and saves before-restore copy", () => {
    const bdir = join(dataDir, "backups");
    mkdirSync(bdir, { recursive: true });
    writeFileSync(join(dataDir, "tasks.json"), JSON.stringify([{ id: "init", title: "Initial Task" }]));
    writeFileSync(join(bdir, "tasks-2026-01-08.json"), JSON.stringify([{ id: "restored", title: "Restored Offline" }]));

    const res = cli("restore", "tasks-2026-01-08.json");
    expect(res.code).toBe(0);
    expect(res.out).toContain("restored tasks-2026-01-08.json");

    // Check target file updated
    const content = readFileSync(join(dataDir, "tasks.json"), "utf-8");
    expect(content).toContain("Restored Offline");

    // Check before-restore copy exists holding Initial Task
    // The directory is shared with the earlier restore test, so take the newest copy by name
    // (the time stamp in the name sorts correctly); readdirSync order is not defined.
    const beforeRestore = readdirSync(bdir)
      .filter((f) => f.includes("before-restore"))
      .sort()
      .reverse();
    expect(beforeRestore.length).toBeGreaterThan(0);
    const beforeContent = readFileSync(join(bdir, beforeRestore[0]), "utf-8");
    expect(beforeContent).toContain("Initial Task");
  });

  test("restore command fails non-zero on missing or invalid file", () => {
    expect(cli("restore").code).not.toBe(0);
    expect(cli("restore", "tasks-1999-01-01.json").code).not.toBe(0);
    expect(cli("restore", "../tasks.json").code).not.toBe(0);
  });

  test("restore command with running server restores through API", async () => {
    const sPort = freePort();
    const started = cli("start", `--port=${sPort}`);
    expect(started.code).toBe(0);

    try {
      const bdir = join(dataDir, "backups");
      mkdirSync(bdir, { recursive: true });
      writeFileSync(join(bdir, "tasks-2026-01-09.json"), JSON.stringify([{ id: "api-task", title: "Via API Restore" }]));

      const res = cli("restore", "tasks-2026-01-09.json", `--port=${sPort}`);
      expect(res.code).toBe(0);
      expect(res.out).toContain("restored tasks-2026-01-09.json");

      const fetchRes = await fetch(`http://127.0.0.1:${sPort}/api/tasks`);
      const body = (await fetchRes.json()) as { tasks: Array<{ title: string }> };
      expect(body.tasks.map((t) => t.title)).toContain("Via API Restore");
    } finally {
      cli("stop");
    }
  });
  test("help command and flags print usage, commands, options, and env vars", () => {
    for (const flag of ["help", "--help", "-h"]) {
      const res = cli(flag);
      expect(res.code).toBe(0);
      expect(res.out.toLowerCase()).toContain("usage:");
      for (const cmd of [
        "start",
        "stop",
        "restart",
        "status",
        "open",
        "app",
        "install-skill",
        "backups",
        "restore",
        "help",
      ]) {
        expect(res.out).toContain(cmd);
      }
      expect(res.out).toContain("--port");
      expect(res.out).toContain("--version");
      expect(res.out).toContain("BUNDO_DATA_DIR");
      expect(res.out).toContain("BUNDO_BACKUP_KEEP");
    }
  });

  test("unknown command exits 1, prints error and help, and does not start server", () => {
    const res = cli("frobnicate");
    expect(res.code).toBe(1);
    expect(res.out).toContain("unknown command: frobnicate");
    expect(res.out.toLowerCase()).toContain("usage:");
    expect(existsSync(join(dataDir, "bun-do.pid"))).toBe(false);
  });

  test("bad port values are rejected with exit 1 and an error message", () => {
    for (const bad of ["abc", "0", "70000", "-1"]) {
      const res = cli("start", `--port=${bad}`);
      expect(res.code).toBe(1);
      expect(res.out).toContain("--port must be a whole number 1 to 65535");
    }
  });

  test("status exits 1 when stopped and 0 when running with full metadata", async () => {
    cli("stop");
    const stopped = cli("status");
    expect(stopped.code).toBe(1);
    expect(stopped.out).toContain("not running");
    expect(stopped.out).toContain(dataDir);

    const sPort = freePort();
    cli("start", `--port=${sPort}`);
    try {
      const running = cli("status", `--port=${sPort}`);
      expect(running.code).toBe(0);
      expect(running.out).toContain("running (pid");
      const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as { version: string };
      expect(running.out).toContain(pkg.version);
      expect(running.out).toContain(dataDir);
      expect(running.out).toContain(String(sPort));
      expect(running.out).toContain("bun-do.log");
    } finally {
      cli("stop");
    }
  });

  test("start on a busy port prints log lines and exits 1", async () => {
    const busyPort = freePort();
    const busyProc = Bun.spawn([
      "bun",
      "-e",
      `Bun.serve({ hostname: "127.0.0.1", port: ${busyPort}, fetch: () => new Response("busy") }); await Bun.sleep(60000)`,
    ]);
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${busyPort}`);
        if (r.ok) break;
      } catch {}
      await Bun.sleep(50);
    }
    try {
      const res = cli("start", `--port=${busyPort}`);
      expect(res.code).toBe(1);
      expect(res.out).toMatch(/in use|EADDRINUSE|log/i);
    } finally {
      busyProc.kill();
      cli("stop");
    }
  });
});
