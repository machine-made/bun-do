#!/usr/bin/env bun
// bun-do CLI — service manager + server entry point
import { join } from "path";
import { homedir } from "os";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  openSync,
  copyFileSync,
  readdirSync,
  renameSync,
  statSync,
} from "fs";
import { spawn } from "child_process";
import { createConnection } from "net";

const DATA_DIR = process.env.BUNDO_DATA_DIR || join(homedir(), ".bun-do");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!process.env.BUNDO_DATA_DIR) process.env.BUNDO_DATA_DIR = DATA_DIR;

const PID_FILE = join(DATA_DIR, "bun-do.pid");
const LOG_FILE = join(DATA_DIR, "bun-do.log");

const args = process.argv.slice(2);

// --version / -v: print version from package.json and exit
if (args.includes("--version") || args.includes("-v")) {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf-8"));
  console.log(pkg.version);
  process.exit(0);
}

// --serve: internal flag — run server in foreground (used by background spawner)
// Must be checked before service manager code — execution must not fall through.
if (args.includes("--serve")) {
  await import("./server.ts");
  // server.ts calls Bun.serve() which keeps the event loop alive
} else {
function printHelp(out: (msg: string) => void = console.log): void {
  out("Usage: bun-do [command] [options]");
  out("");
  out("Commands:");
  out("  start          Start background server (default)");
  out("  stop           Stop background server");
  out("  restart        Restart background server");
  out("  status         Show server status and configuration");
  out("  open           Start server (if needed) and open in default browser");
  out("  app            Open native macOS app window (macOS only)");
  out("  install-skill  Install bun-do skill to Claude Code (~/.claude/skills)");
  out("  backups        List available database backups");
  out("  restore        Restore data from a backup file (bun-do restore <file>)");
  out("  help           Show this help message");
  out("");
  out("Options:");
  out("  --port=<port>  Port to listen on (1-65535, default: 8000)");
  out("  --version, -v  Print version and exit");
  out("  --help, -h     Show this help message");
  out("");
  out("Environment:");
  out("  BUNDO_DATA_DIR     Directory for data and backups (default: ~/.bun-do)");
  out("  BUNDO_BACKUP_KEEP  Number of daily backups to keep (default: 30)");
}

if (args.includes("help") || args.includes("--help") || args.includes("-h")) {
  printHelp(console.log);
  process.exit(0);
}

const portArgs = args.filter((a) => a === "--port" || a.startsWith("--port="));
let port = "8000";
if (portArgs.length > 0) {
  const pArg = portArgs[0];
  if (!pArg.startsWith("--port=")) {
    console.error("[bun-do] error: --port must be a whole number 1 to 65535");
    process.exit(1);
  }
  const rawPort = pArg.slice("--port=".length);
  if (!/^\d+$/.test(rawPort)) {
    console.error("[bun-do] error: --port must be a whole number 1 to 65535");
    process.exit(1);
  }
  const portNum = parseInt(rawPort, 10);
  if (portNum < 1 || portNum > 65535) {
    console.error("[bun-do] error: --port must be a whole number 1 to 65535");
    process.exit(1);
  }
  port = rawPort;
}

const KNOWN_COMMANDS: Record<string, true> = {
  start: true,
  stop: true,
  restart: true,
  status: true,
  open: true,
  app: true,
  "install-skill": true,
  backups: true,
  restore: true,
  help: true,
};

const positionals = args.filter((a) => !a.startsWith("-"));
let command = "start";
if (positionals.length > 0) {
  command = positionals[0];
  if (!KNOWN_COMMANDS[command]) {
    console.error(`unknown command: ${command}`);
    console.error("");
    printHelp(console.error);
    process.exit(1);
  }
}

const unknownFlag = args.find(
  (a) =>
    a.startsWith("-") &&
    !a.startsWith("--port=") &&
    a !== "--port" &&
    a !== "--openclaw" &&
    a !== "--version" &&
    a !== "-v" &&
    a !== "--help" &&
    a !== "-h" &&
    a !== "--serve"
);
if (unknownFlag) {
  console.error(`unknown command: ${unknownFlag}`);
  console.error("");
  printHelp(console.error);
  process.exit(1);
}

const url = `http://localhost:${port}`;
const BACKUPS_DIR = join(DATA_DIR, "backups");
const BACKUP_FILENAME_RE = /^(tasks|projects)-(\d{4}-\d{2}-\d{2})(T\d{6}-before-restore)?\.json$/;

function formatDateTimeBeforeRestore(d = new Date()): string {
  const datePart =
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0");
  const timePart =
    String(d.getHours()).padStart(2, "0") +
    String(d.getMinutes()).padStart(2, "0") +
    String(d.getSeconds()).padStart(2, "0");
  return `${datePart}T${timePart}`;
}

function getPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
  return isNaN(pid) ? null : pid;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForReady(childPid?: number): Promise<boolean> {
  const portNum = parseInt(port, 10);
  for (let i = 0; i < 40; i++) {
    if (childPid && !isRunning(childPid)) {
      return false;
    }
    const up = await new Promise<boolean>((resolve) => {
      const s = createConnection({ host: "127.0.0.1", port: portNum });
      s.setTimeout(100, () => { s.destroy(); resolve(false); });
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => { s.destroy(); resolve(false); });
    });
    if (up) {
      try {
        const res = await fetch(`http://127.0.0.1:${portNum}/api/tasks`, {
          headers: { Host: `127.0.0.1:${portNum}` },
          signal: AbortSignal.timeout(200),
        });
        if (res.ok) {
          const data = (await res.json()) as { tasks?: unknown };
          if (data && Array.isArray(data.tasks)) return true;
        }
      } catch {}
    }
    await Bun.sleep(100);
  }
  return false;
}

function stop(): boolean {
  const pid = getPid();
  if (pid && isRunning(pid)) {
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && isRunning(pid)) {
      Bun.sleepSync(100);
    }
    if (isRunning(pid)) process.kill(pid, "SIGKILL");
    try { unlinkSync(PID_FILE); } catch {}
    console.log(`[bun-do] stopped (pid ${pid})`);
    return true;
  }
  try { unlinkSync(PID_FILE); } catch {}
  console.log("[bun-do] not running");
  return false;
}

async function start(): Promise<boolean> {
  const pid = getPid();
  if (pid && isRunning(pid)) {
    console.log(`[bun-do] already running (pid ${pid})`);
    return true;
  }

  const logFd = openSync(LOG_FILE, "a");
  const child = spawn("bun", [import.meta.filename, "--serve", `--port=${port}`], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, BUNDO_DATA_DIR: DATA_DIR },
  });
  child.unref();

  if (child.pid) writeFileSync(PID_FILE, String(child.pid));

  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf-8"));
  const ready = await waitForReady(child.pid);
  if (!ready) {
    if (child.pid && !isRunning(child.pid)) {
      try { unlinkSync(PID_FILE); } catch {}
    }
    console.error(`[bun-do] failed to reach server on ${url}`);
    if (existsSync(LOG_FILE)) {
      const logContent = readFileSync(LOG_FILE, "utf-8").trim();
      if (logContent) {
        console.error(`[bun-do] last lines of log (${LOG_FILE}):`);
        const lines = logContent.split("\n");
        console.error(lines.slice(-10).join("\n"));
      }
    }
    process.exit(1);
  }

  console.log(`[bun-do] v${pkg.version} started (pid ${child.pid})`);
  console.log(`[bun-do] ${url}`);
  console.log(`[bun-do] log: ${LOG_FILE}`);
  return true;
}

function status(): void {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf-8"));
  const pid = getPid();
  const running = pid !== null && isRunning(pid);
  if (running) {
    console.log(`[bun-do] running (pid ${pid})`);
    console.log(`[bun-do] version: ${pkg.version}`);
    console.log(`[bun-do] ${url}`);
    console.log(`[bun-do] data: ${DATA_DIR}`);
    console.log(`[bun-do] log: ${LOG_FILE}`);
    process.exit(0);
  } else {
    try { unlinkSync(PID_FILE); } catch {}
    console.log("[bun-do] not running");
    console.log(`[bun-do] version: ${pkg.version}`);
    console.log(`[bun-do] ${url}`);
    console.log(`[bun-do] data: ${DATA_DIR}`);
    console.log(`[bun-do] log: ${LOG_FILE}`);
    process.exit(1);
  }
}

function openBrowser() {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

async function openApp() {
  if (process.platform !== "darwin") {
    console.log("[bun-do] native app is macOS only — use 'bun-do open' for browser");
    process.exit(1);
  }

  const cacheDir = join(DATA_DIR, "app");
  const binary = join(cacheDir, "bun-do-webview");
  const source = join(import.meta.dir, "bin", "bun-do-webview.swift");

  // Compile on first run (caches in ~/.bun-do/app/)
  if (!existsSync(binary)) {
    if (!existsSync(source)) {
      console.log("[bun-do] bin/bun-do-webview.swift not found in package");
      process.exit(1);
    }
    console.log("[bun-do] compiling native app (first run only)...");
    mkdirSync(cacheDir, { recursive: true });
    const result = Bun.spawnSync([
      "swiftc", "-o", binary, source, "-framework", "Cocoa", "-framework", "WebKit",
    ]);
    if (result.exitCode !== 0) {
      console.log("[bun-do] swift compilation failed — do you have Xcode command line tools?");
      console.log(result.stderr.toString());
      process.exit(1);
    }
    console.log("[bun-do] compiled → " + binary);
  }

  // Start server if needed
  await start();

  // Launch native window
  spawn(binary, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, BUNDO_PORT: port },
  }).unref();
  console.log("[bun-do] native app opened");
}

function installSkill() {
  const src = join(import.meta.dir, "skill", "SKILL.md");
  if (!existsSync(src)) {
    console.log("[bun-do] skill/SKILL.md not found in package");
    process.exit(1);
  }
  const isOpenClaw = args.includes("--openclaw");
  const destDir = isOpenClaw
    ? join(homedir(), ".openclaw", "workspace", "skills", "bun-do-api")
    : join(homedir(), ".claude", "skills", "bun-do-api");
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, join(destDir, "SKILL.md"));
  console.log(`[bun-do] skill installed → ${join(destDir, "SKILL.md")}`);
  if (isOpenClaw) {
    console.log("[bun-do] restart OpenClaw to activate");
  } else {
    console.log("[bun-do] reload Claude Code to activate (or start a new session)");
  }
}

function listBackups(): void {
  if (!existsSync(BACKUPS_DIR)) {
    console.log("[bun-do] no backups found");
    return;
  }
  try {
    const files = readdirSync(BACKUPS_DIR)
      .filter((f) => BACKUP_FILENAME_RE.test(f))
      .sort((a, b) => {
        const ka = a.replace(/^(tasks|projects)-/, "");
        const kb = b.replace(/^(tasks|projects)-/, "");
        return kb.localeCompare(ka) || a.localeCompare(b);
      });
    if (files.length === 0) {
      console.log("[bun-do] no backups found");
      return;
    }
    for (const f of files) {
      const full = join(BACKUPS_DIR, f);
      let entries = 0;
      let size = 0;
      try {
        const stat = statSync(full);
        size = stat.size;
        const content = readFileSync(full, "utf-8");
        const parsed: unknown = JSON.parse(content);
        if (Array.isArray(parsed)) {
          entries = parsed.length;
        } else if (parsed && typeof parsed === "object") {
          if ("tasks" in parsed && Array.isArray(parsed.tasks)) entries = parsed.tasks.length;
          else if ("projects" in parsed && Array.isArray(parsed.projects)) entries = parsed.projects.length;
        }
      } catch {}
      const m = f.match(BACKUP_FILENAME_RE);
      const kind = m ? m[1] : "tasks";
      console.log(`${f}  (${entries} ${kind === "tasks" ? "tasks" : "projects"}, ${size} bytes)`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[bun-do] error listing backups: ${msg}`);
    process.exit(1);
  }
}

async function isServerUp(targetUrl: string): Promise<boolean> {
  const pid = getPid();
  if (!pid || !isRunning(pid)) return false;
  try {
    const res = await fetch(`${targetUrl}/api/tasks`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function restoreViaApi(targetUrl: string, file: string): Promise<void> {
  try {
    const res = await fetch(`${targetUrl}/api/backups/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file }),
    });
    if (res.ok) {
      console.log(`[bun-do] restored ${file}`);
      return;
    }
    const body: unknown = await res.json().catch(() => ({}));
    let detail = "restore failed";
    if (body && typeof body === "object" && "detail" in body && typeof body.detail === "string") {
      detail = body.detail;
    }
    console.error(`[bun-do] error: ${detail}`);
    process.exit(1);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[bun-do] error connecting to server: ${msg}`);
    process.exit(1);
  }
}

function restoreDirect(file: string): void {
  if (file.includes("/") || file.includes("\\") || file.includes("..")) {
    console.error("[bun-do] error: file must be a bare file name without path");
    process.exit(1);
  }

  const match = file.match(BACKUP_FILENAME_RE);
  if (!match) {
    console.error("[bun-do] error: file name must match the backup pattern");
    process.exit(1);
  }

  const backupPath = join(BACKUPS_DIR, file);
  if (!existsSync(backupPath)) {
    console.error(`[bun-do] error: backup file not found: ${file}`);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    const content = readFileSync(backupPath, "utf-8");
    parsed = JSON.parse(content);
  } catch {
    console.error(`[bun-do] error: backup file is unreadable or not valid JSON: ${file}`);
    process.exit(1);
  }

  const kind = match[1] as "tasks" | "projects";
  let isValid = false;
  if (kind === "tasks") {
    if (Array.isArray(parsed) || (parsed && typeof parsed === "object" && "tasks" in parsed && Array.isArray(parsed.tasks))) {
      isValid = true;
    }
  } else {
    if (Array.isArray(parsed) || (parsed && typeof parsed === "object" && "projects" in parsed && Array.isArray(parsed.projects))) {
      isValid = true;
    }
  }

  if (!isValid) {
    console.error(`[bun-do] error: backup file has invalid shape for ${kind}`);
    process.exit(1);
  }

  if (!existsSync(BACKUPS_DIR)) mkdirSync(BACKUPS_DIR, { recursive: true });
  const beforeRestoreName = `${kind}-${formatDateTimeBeforeRestore()}-before-restore.json`;
  const beforeRestorePath = join(BACKUPS_DIR, beforeRestoreName);
  const currentPath = join(DATA_DIR, `${kind}.json`);
  if (existsSync(currentPath)) {
    copyFileSync(currentPath, beforeRestorePath);
  }

  // Restore file first before retention, so restoring the oldest backup is never pruned before read
  const tmp = currentPath + ".tmp";
  const rawContent = readFileSync(backupPath, "utf-8");
  writeFileSync(tmp, rawContent);
  renameSync(tmp, currentPath);

  const rawKeep = process.env.BUNDO_BACKUP_KEEP;
  let keep = 30;
  if (rawKeep !== undefined && rawKeep !== "") {
    const trimmed = rawKeep.trim();
    if (/^\d+$/.test(trimmed)) {
      const val = parseInt(trimmed, 10);
      if (val >= 1) keep = val;
    }
  }
  const backupFiles = readdirSync(BACKUPS_DIR)
    .filter((f) => BACKUP_FILENAME_RE.exec(f)?.[1] === kind)
    .sort()
    .reverse();
  if (backupFiles.length > keep) {
    for (const f of backupFiles.slice(keep)) {
      try { unlinkSync(join(BACKUPS_DIR, f)); } catch {}
    }
  }

  console.log(`[bun-do] restored ${file}`);
}

switch (command) {
  case "start":
    await start();
    break;
  case "stop":
    stop();
    break;
  case "restart":
    stop();
    await start();
    break;
  case "status":
    status();
    break;
  case "open":
    await start();
    openBrowser();
    break;
  case "app":
    await openApp();
    break;
  case "install-skill":
    installSkill();
    break;
  case "backups":
    listBackups();
    break;
  case "restore": {
    const restoreIdx = args.indexOf("restore");
    const fileArg = restoreIdx !== -1 && args[restoreIdx + 1] && !args[restoreIdx + 1].startsWith("--")
      ? args[restoreIdx + 1]
      : undefined;
    if (!fileArg) {
      console.error("[bun-do] error: restore requires a backup file name");
      process.exit(1);
    }
    if (await isServerUp(url)) {
      await restoreViaApi(url, fileArg);
    } else {
      restoreDirect(fileArg);
    }
    break;
  }
  case "help":
    printHelp(console.log);
    process.exit(0);
    break;
}
} // end else (service manager)
