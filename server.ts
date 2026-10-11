// server.ts — Todo app backend (Bun, zero dependencies)

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { extname, join, resolve } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

interface Recurrence {
  type: "weekly" | "monthly" | "yearly";
  day?: number;
  dow?: number;
  month?: number;
}

interface Task {
  id: string;
  title: string;
  date: string;
  priority: "P0" | "P1" | "P2" | "P3";
  notes: string;
  done: boolean;
  type: "task" | "deadline" | "reminder" | "payment";
  subtasks: Subtask[];
  recurrence: Recurrence | null;
  sort_order: number;
  amount: string;
  currency: string;
  tags: string[];
}

interface Entry {
  id: string;
  date: string;
  summary: string;
}

interface Project {
  id: string;
  name: string;
  repo: string;
  status: "active" | "paused" | "completed" | "archived";
  description: string;
  entries: Entry[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PKG_DIR = import.meta.dir;
const DATA_DIR = process.env.BUNDO_DATA_DIR || join(process.cwd(), "data");
const TASKS_PATH = join(DATA_DIR, "tasks.json");
const PROJECTS_PATH = join(DATA_DIR, "projects.json");
const STATIC_DIR = join(PKG_DIR, "static");

const PRIORITY_LABELS = ["P0", "P1", "P2", "P3"] as const;
const PRIORITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const TASK_TYPES = ["task", "deadline", "reminder", "payment"] as const;
const CURRENCIES = ["CHF", "USD", "EUR", "BRL"];
const RECURRENCE_TYPES = ["weekly", "monthly", "yearly"];
const PROJECT_STATUSES = ["active", "paused", "completed", "archived"] as const;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

function sanitizeRecurrence(raw: unknown): Recurrence | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!RECURRENCE_TYPES.includes(r.type as string)) return null;
  return {
    type: r.type as Recurrence["type"],
    ...(r.day !== undefined && { day: Number(r.day) }),
    ...(r.dow !== undefined && { dow: Number(r.dow) }),
    ...(r.month !== undefined && { month: Number(r.month) }),
  };
}

function validateIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (!raw.every((id) => typeof id === "string")) return null;
  return raw;
}

function validCurrency(raw: unknown): string {
  return CURRENCIES.includes(raw as string) ? (raw as string) : "CHF";
}

function safeUrl(raw: unknown): string {
  const url = String(raw ?? "").trim();
  if (!url) return "";
  return /^https?:\/\//i.test(url) ? url : "";
}

const MAX_TAGS = 10;
const MAX_TAG_LEN = 32;

/** One tag: trim, drop a leading #, lower case, spaces to "-", keep letters, digits, "-" and "_". */
function normalizeTag(raw: string): string {
  let s = raw.normalize("NFC").trim().replace(/^#+/, "").trim().toLowerCase();
  s = s.replace(/\s+/gu, "-").replace(/[^\p{L}\p{Nd}_-]+/gu, "");
  const chars = [...s];
  return chars.length > MAX_TAG_LEN ? chars.slice(0, MAX_TAG_LEN).join("") : s;
}

/** Array of strings, or one comma-separated string. Empties and duplicates dropped; first 10 win. */
function normalizeTags(raw: unknown): string[] {
  const parts = typeof raw === "string"
    ? raw.split(",")
    : Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === "string")
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const tag = normalizeTag(part);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function parseJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw new Response(JSON.stringify({ detail: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function today(): string {
  // Local calendar date. toISOString() gives the UTC date, which is a day off near midnight.
  return formatDate(new Date());
}

function isoToDate(value: string | null | undefined): string {
  if (!value) return today();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    if (!isNaN(date.getTime())) return value;
  }
  return today();
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function nextOccurrence(currentDate: string, recurrence: Recurrence): string {
  const [y, m, d] = currentDate.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const rtype = recurrence.type;

  if (rtype === "weekly") {
    const dow = recurrence.dow ?? (date.getDay() === 0 ? 6 : date.getDay() - 1);
    // Convert JS day (0=Sun) to Mon-based (0=Mon)
    const currentDow = date.getDay() === 0 ? 6 : date.getDay() - 1;
    let daysAhead = dow - currentDow;
    if (daysAhead <= 0) daysAhead += 7;
    const next = new Date(date);
    next.setDate(next.getDate() + daysAhead);
    return formatDate(next);
  }

  if (rtype === "monthly") {
    const day = recurrence.day ?? d;
    let nextMonth = m;
    let nextYear = y;
    if (nextMonth === 12) {
      nextMonth = 1;
      nextYear++;
    } else {
      nextMonth++;
    }
    const maxDay = daysInMonth(nextYear, nextMonth);
    return `${nextYear}-${String(nextMonth).padStart(2, "0")}-${String(Math.min(day, maxDay)).padStart(2, "0")}`;
  }

  if (rtype === "yearly") {
    const month = recurrence.month ?? m;
    const day = recurrence.day ?? d;
    const nextYear = y + 1;
    const maxDay = daysInMonth(nextYear, month);
    return `${nextYear}-${String(month).padStart(2, "0")}-${String(Math.min(day, maxDay)).padStart(2, "0")}`;
  }

  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  return formatDate(next);
}

function formatDate(d: Date): string {
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

// ---------------------------------------------------------------------------
// In-memory store + atomic persistence
// ---------------------------------------------------------------------------

let tasks: Task[] = [];
let projects: Project[] = [];

function parseTasks(raw: unknown): Task[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item: unknown) => typeof item === "object" && item !== null)
    .map((item: Record<string, unknown>) => ({
      id: (item.id as string) || crypto.randomUUID(),
      title: String(item.title ?? "").trim() || "Untitled task",
      date: isoToDate(item.date as string),
      priority: PRIORITY_LABELS.includes(item.priority as Task["priority"])
        ? (item.priority as Task["priority"])
        : "P2",
      notes: String(item.notes ?? "").trim(),
      done: Boolean(item.done),
      type: TASK_TYPES.includes(item.type as Task["type"])
        ? (item.type as Task["type"])
        : "task",
      subtasks: (item.subtasks as Subtask[]) || [],
      recurrence: sanitizeRecurrence(item.recurrence),
      sort_order: (item.sort_order as number) ?? 0,
      amount: String(item.amount ?? "").trim(),
      currency: validCurrency(item.currency),
      tags: normalizeTags(item.tags),
    }));
}

function loadTasksFromDisk(): Task[] {
  if (!existsSync(TASKS_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(TASKS_PATH, "utf-8"));
    const arr = Array.isArray(raw) ? raw : (raw?.tasks ?? []);
    return parseTasks(arr);
  } catch {
    return [];
  }
}

function loadProjectsFromDisk(): Project[] {
  if (!existsSync(PROJECTS_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(PROJECTS_PATH, "utf-8"));
    if (!Array.isArray(raw)) return [];
    return raw;
  } catch {
    return [];
  }
}

function saveTasks(): void {
  const tmp = TASKS_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(tasks, null, 2));
  renameSync(tmp, TASKS_PATH);
}

function saveProjects(): void {
  const tmp = PROJECTS_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(projects, null, 2));
  renameSync(tmp, PROJECTS_PATH);
}

function findTask(id: string): Task | undefined {
  return tasks.find((t) => t.id === id);
}

function findProject(id: string): Project | undefined {
  return projects.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// Business logic
// ---------------------------------------------------------------------------

function createNextRecurring(task: Task): Task {
  const nextDate = nextOccurrence(task.date, task.recurrence!);
  return {
    id: crypto.randomUUID(),
    title: task.title,
    date: nextDate,
    priority: task.priority,
    notes: task.notes,
    done: false,
    type: task.type,
    subtasks: task.subtasks.map((st) => ({
      id: crypto.randomUUID(),
      title: st.title,
      done: false,
    })),
    recurrence: task.recurrence,
    sort_order: 0,
    amount: task.amount,
    currency: task.currency,
    tags: [...task.tags],
  };
}

function carryOver(todayStr: string): number {
  let moved = 0;
  for (const task of tasks) {
    if (task.done) continue;
    if (task.recurrence) continue;
    if (task.type === "payment") continue;
    if (task.date < todayStr) {
      task.date = todayStr;
      moved++;
    }
  }
  if (moved) saveTasks();
  return moved;
}

function sortTasks(list: Task[]): Task[] {
  return [...list].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const pa = PRIORITY_ORDER[a.priority] ?? 99;
    const pb = PRIORITY_ORDER[b.priority] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
  });
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function notFound(detail: string): Response {
  return json({ detail }, 404);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// -- Tasks --

function handleGetTasks(url: URL): Response {
  const moved = carryOver(today());
  let list = tasks;
  if (url.searchParams.has("tag")) {
    const tag = normalizeTag(url.searchParams.get("tag") ?? "");
    list = tag ? tasks.filter((t) => t.tags.includes(tag)) : [];
  }
  return json({ tasks: sortTasks(list), carried_over: moved });
}

async function handleCreateTask(req: Request): Promise<Response> {
  const body = await parseJson(req);
  const newTask: Task = {
    id: crypto.randomUUID(),
    title: String(body.title ?? "").trim() || "Untitled task",
    date: isoToDate(body.date),
    priority: PRIORITY_LABELS.includes(body.priority) ? body.priority : "P2",
    notes: String(body.notes ?? "").trim(),
    done: false,
    type: TASK_TYPES.includes(body.type) ? body.type : "task",
    subtasks: [],
    recurrence: sanitizeRecurrence(body.recurrence),
    sort_order: 0,
    amount: String(body.amount ?? "").trim(),
    currency: validCurrency(body.currency),
    tags: normalizeTags(body.tags),
  };
  tasks.push(newTask);
  saveTasks();
  return json(newTask);
}

async function handleReorderTasks(req: Request): Promise<Response> {
  const body = await parseJson(req);
  const ids = validateIds(body.ids);
  if (!ids) return json({ detail: "ids must be a string array" }, 400);
  const idToOrder: Record<string, number> = {};
  ids.forEach((id, i) => (idToOrder[id] = i));
  for (const task of tasks) {
    if (task.id in idToOrder) task.sort_order = idToOrder[task.id];
  }
  saveTasks();
  return json({ ok: true });
}

function handleClearDone(): Response {
  const before = tasks.length;
  tasks = tasks.filter((t) => !t.done);
  const cleared = before - tasks.length;
  saveTasks();
  return json({ cleared });
}

async function handleUpdateTask(taskId: string, req: Request): Promise<Response> {
  const body = await parseJson(req);
  const task = findTask(taskId);
  if (!task) return notFound("Task not found");

  if (body.title !== undefined) task.title = String(body.title).trim() || task.title;
  if (body.date !== undefined) task.date = isoToDate(body.date);
  if (body.priority !== undefined && PRIORITY_LABELS.includes(body.priority)) task.priority = body.priority;
  if (body.notes !== undefined) task.notes = String(body.notes).trim();
  if (body.type !== undefined && TASK_TYPES.includes(body.type)) task.type = body.type;
  if (body.amount !== undefined) task.amount = String(body.amount).trim();
  if (body.currency !== undefined && CURRENCIES.includes(body.currency)) task.currency = body.currency;
  if (body.tags !== undefined) task.tags = normalizeTags(body.tags);
  if (body.recurrence !== undefined) task.recurrence = sanitizeRecurrence(body.recurrence);
  if (body.done !== undefined) {
    const wasDone = task.done;
    task.done = Boolean(body.done);
    if (body.done && !wasDone && task.recurrence) {
      tasks.push(createNextRecurring(task));
    }
  }
  saveTasks();
  return json(task);
}

function handleDeleteTask(taskId: string): Response {
  const before = tasks.length;
  tasks = tasks.filter((t) => t.id !== taskId);
  if (tasks.length === before) return notFound("Task not found");
  saveTasks();
  return json({ ok: true });
}

// -- Subtasks --

async function handleAddSubtask(taskId: string, req: Request): Promise<Response> {
  const body = await parseJson(req);
  const task = findTask(taskId);
  if (!task) return notFound("Task not found");
  const subtask: Subtask = {
    id: crypto.randomUUID(),
    title: String(body.title ?? "").trim() || "Untitled subtask",
    done: false,
  };
  task.subtasks.push(subtask);
  saveTasks();
  return json(subtask);
}

async function handleUpdateSubtask(taskId: string, subId: string, req: Request): Promise<Response> {
  const body = await parseJson(req);
  const task = findTask(taskId);
  if (!task) return notFound("Task not found");
  const sub = task.subtasks.find((s) => s.id === subId);
  if (!sub) return notFound("Subtask not found");
  if (body.done !== undefined) sub.done = Boolean(body.done);
  if (body.title !== undefined) sub.title = String(body.title).trim() || sub.title;
  saveTasks();
  return json(sub);
}

function handleDeleteSubtask(taskId: string, subId: string): Response {
  const task = findTask(taskId);
  if (!task) return notFound("Task not found");
  const before = task.subtasks.length;
  task.subtasks = task.subtasks.filter((s) => s.id !== subId);
  if (task.subtasks.length === before) return notFound("Subtask not found");
  saveTasks();
  return json({ ok: true });
}

async function handleReorderSubtasks(taskId: string, req: Request): Promise<Response> {
  const body = await parseJson(req);
  const ids = validateIds(body.ids);
  if (!ids) return json({ detail: "ids must be a string array" }, 400);
  const task = findTask(taskId);
  if (!task) return notFound("Task not found");
  const byId = new Map(task.subtasks.map((s) => [s.id, s]));
  const reordered = ids.map((id) => byId.get(id)).filter(Boolean) as Subtask[];
  for (const s of task.subtasks) {
    if (!ids.includes(s.id)) reordered.push(s);
  }
  task.subtasks = reordered;
  saveTasks();
  return json({ ok: true });
}

// -- Projects --

function handleGetProjects(): Response {
  return json({ projects });
}

async function handleCreateProject(req: Request): Promise<Response> {
  const body = await parseJson(req);
  const project: Project = {
    id: crypto.randomUUID(),
    name: String(body.name ?? "").trim() || "Untitled project",
    repo: safeUrl(body.repo),
    status: "active",
    description: String(body.description ?? "").trim(),
    entries: [],
  };
  projects.push(project);
  saveProjects();
  return json(project);
}

async function handleUpdateProject(projectId: string, req: Request): Promise<Response> {
  const body = await parseJson(req);
  const proj = findProject(projectId);
  if (!proj) return notFound("Project not found");
  if (body.name !== undefined) proj.name = String(body.name).trim() || proj.name;
  if (body.repo !== undefined) proj.repo = safeUrl(body.repo);
  if (body.status !== undefined && PROJECT_STATUSES.includes(body.status)) proj.status = body.status;
  if (body.description !== undefined) proj.description = String(body.description).trim();
  saveProjects();
  return json(proj);
}

function handleDeleteProject(projectId: string): Response {
  const before = projects.length;
  projects = projects.filter((p) => p.id !== projectId);
  if (projects.length === before) return notFound("Project not found");
  saveProjects();
  return json({ ok: true });
}

async function handleAddEntry(projectId: string, req: Request): Promise<Response> {
  const body = await parseJson(req);
  const proj = findProject(projectId);
  if (!proj) return notFound("Project not found");
  const entry: Entry = {
    id: crypto.randomUUID(),
    date: isoToDate(body.date),
    summary: String(body.summary ?? "").trim() || "No summary",
  };
  proj.entries.push(entry);
  saveProjects();
  return json(entry);
}

function handleDeleteEntry(projectId: string, entryId: string): Response {
  const proj = findProject(projectId);
  if (!proj) return notFound("Project not found");
  const before = proj.entries.length;
  proj.entries = proj.entries.filter((e) => e.id !== entryId);
  if (proj.entries.length === before) return notFound("Entry not found");
  saveProjects();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // -- Host check: answer only requests addressed to a loopback name --
  // A web page that points its own domain at 127.0.0.1 (DNS rebinding) sends that domain here.
  const host = (req.headers.get("host") ?? "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(host.replace(/:\d+$/, ""))) {
    return new Response("Forbidden", { status: 403 });
  }

  // -- Static files --
  if (path === "/" || path === "/index.html") {
    const file = Bun.file(join(STATIC_DIR, "index.html"));
    if (await file.exists()) {
      return new Response(file, { headers: { "Content-Type": "text/html" } });
    }
    return new Response("Not found", { status: 404 });
  }

  if (path.startsWith("/static/")) {
    const filepath = path.slice("/static/".length);
    const resolved = resolve(STATIC_DIR, filepath);
    if (!resolved.startsWith(STATIC_DIR + "/")) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(resolved);
    if (await file.exists()) {
      const ext = extname(filepath);
      return new Response(file, { headers: { "Content-Type": MIME[ext] || "application/octet-stream" } });
    }
    return new Response("Not found", { status: 404 });
  }

  // -- CSRF check for mutating API requests --
  // Browsers send Origin on every cross-site write; it must be this server's own origin.
  // Requests without Origin (curl, the MCP server) are allowed.
  if (path.startsWith("/api/") && method !== "GET") {
    const origin = req.headers.get("origin");
    if (origin !== null && origin.toLowerCase() !== `http://${host}`) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  // -- API routes --
  let match: RegExpMatchArray | null;

  if (path === "/api/tasks" && method === "GET") return handleGetTasks(url);
  if (path === "/api/tasks" && method === "POST") return handleCreateTask(req);
  if (path === "/api/tasks/reorder" && method === "POST") return handleReorderTasks(req);
  if (path === "/api/tasks/clear-done" && method === "POST") return handleClearDone();

  match = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (match) {
    if (method === "PUT") return handleUpdateTask(match[1], req);
    if (method === "DELETE") return handleDeleteTask(match[1]);
  }

  match = path.match(/^\/api\/tasks\/([^/]+)\/subtasks\/reorder$/);
  if (match && method === "POST") return handleReorderSubtasks(match[1], req);

  match = path.match(/^\/api\/tasks\/([^/]+)\/subtasks$/);
  if (match && method === "POST") return handleAddSubtask(match[1], req);

  match = path.match(/^\/api\/tasks\/([^/]+)\/subtasks\/([^/]+)$/);
  if (match) {
    if (method === "PUT") return handleUpdateSubtask(match[1], match[2], req);
    if (method === "DELETE") return handleDeleteSubtask(match[1], match[2]);
  }

  if (path === "/api/projects" && method === "GET") return handleGetProjects();
  if (path === "/api/projects" && method === "POST") return handleCreateProject(req);

  match = path.match(/^\/api\/projects\/([^/]+)$/);
  if (match) {
    if (method === "PUT") return handleUpdateProject(match[1], req);
    if (method === "DELETE") return handleDeleteProject(match[1]);
  }

  match = path.match(/^\/api\/projects\/([^/]+)\/entries$/);
  if (match && method === "POST") return handleAddEntry(match[1], req);

  match = path.match(/^\/api\/projects\/([^/]+)\/entries\/([^/]+)$/);
  if (match && method === "DELETE") return handleDeleteEntry(match[1], match[2]);

  return new Response("Not found", { status: 404 });
}

// ---------------------------------------------------------------------------
// Bootstrap & Start
// ---------------------------------------------------------------------------

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(TASKS_PATH)) {
  const examplePath = join(PKG_DIR, "data", "tasks.example.json");
  const seed = existsSync(examplePath) ? readFileSync(examplePath, "utf-8") : "[]";
  writeFileSync(TASKS_PATH, seed);
}
if (!existsSync(PROJECTS_PATH)) {
  writeFileSync(PROJECTS_PATH, "[]");
}

// Load data into memory once at startup
tasks = loadTasksFromDisk();
projects = loadProjectsFromDisk();

const portArg = Bun.argv.find((a) => a.startsWith("--port="));
const port = portArg ? parseInt(portArg.split("=")[1]) : 8000;

const server = Bun.serve({
  // Loopback only: without a hostname Bun listens on every interface, and the API has no login.
  hostname: "127.0.0.1",
  port,
  async fetch(req: Request): Promise<Response> {
    try {
      return await handleRequest(req);
    } catch (e) {
      if (e instanceof Response) return e;
      return json({ detail: "Internal server error" }, 500);
    }
  },
});

console.log(`[bun-do] listening on http://localhost:${server.port}`);
