// server.ts — Todo app backend (Bun, zero dependencies)

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
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
  type: "daily" | "weekdays" | "weekly" | "monthly" | "yearly";
  day?: number;
  dow?: number;
  month?: number;
  interval?: number;
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
const BACKUPS_DIR = join(DATA_DIR, "backups");

function parseBackupKeep(): number {
  const raw = process.env.BUNDO_BACKUP_KEEP;
  if (raw === undefined || raw === "") return 30;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const val = parseInt(trimmed, 10);
    if (val >= 1) return val;
  }
  console.log(`[bun-do] invalid BUNDO_BACKUP_KEEP "${raw}", must be a whole number of at least 1; using default 30`);
  return 30;
}

const BACKUP_KEEP = parseBackupKeep();
const BACKUP_FILENAME_RE = /^(tasks|projects)-(\d{4}-\d{2}-\d{2})(T\d{6}-before-restore)?\.json$/;
const STATIC_DIR = join(PKG_DIR, "static");

const PRIORITY_LABELS = ["P0", "P1", "P2", "P3"] as const;
const PRIORITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const TASK_TYPES = ["task", "deadline", "reminder", "payment"] as const;
const CURRENCIES = ["CHF", "USD", "EUR", "BRL"];
const RECURRENCE_TYPES = ["daily", "weekdays", "weekly", "monthly", "yearly"];
const PROJECT_STATUSES = ["active", "paused", "completed", "archived"] as const;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Why a recurrence rule is invalid, or null when it is valid. */
function recurrenceError(r: Record<string, unknown>): string | null {
  if (!RECURRENCE_TYPES.includes(r.type as string)) {
    return `recurrence.type must be one of: ${RECURRENCE_TYPES.join(", ")}`;
  }
  if (r.interval !== undefined) {
    if (!Number.isInteger(r.interval) || (r.interval as number) < 1 || (r.interval as number) > 99) {
      return "recurrence.interval must be a whole number between 1 and 99";
    }
    if (r.type === "weekdays" && r.interval !== 1) {
      return "recurrence.interval must be 1 for weekdays";
    }
  }
  if (r.dow !== undefined && (!Number.isInteger(r.dow) || (r.dow as number) < 0 || (r.dow as number) > 6)) {
    return "recurrence.dow must be a whole number between 0 and 6 (0 = Monday)";
  }
  if (r.day !== undefined && (!Number.isInteger(r.day) || (r.day as number) < 1 || (r.day as number) > 31)) {
    return "recurrence.day must be a whole number between 1 and 31";
  }
  if (r.month !== undefined && (!Number.isInteger(r.month) || (r.month as number) < 1 || (r.month as number) > 12)) {
    return "recurrence.month must be a whole number between 1 and 12";
  }
  return null;
}

/** Lenient, for stored files: an invalid rule becomes null so the file still loads. */
function sanitizeRecurrence(raw: unknown): Recurrence | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (recurrenceError(r)) return null;
  return {
    type: r.type as Recurrence["type"],
    ...(r.day !== undefined && { day: r.day as number }),
    ...(r.dow !== undefined && { dow: r.dow as number }),
    ...(r.month !== undefined && { month: r.month as number }),
    ...(r.interval !== undefined && { interval: r.interval as number }),
  };
}

/**
 * Strict, for API writes. Returns the error detail string on an invalid rule, null when
 * raw is null/absent. A rule without its anchor takes it from the task's date
 * (weekly dow, monthly day, yearly month and day), which stops it drifting after a
 * short month. interval is stored only when it is above 1.
 */
function parseRecurrence(raw: unknown, date: string): Recurrence | null | string {
  if (raw == null) return null;
  if (typeof raw !== "object") return "recurrence must be an object or null";
  const r = raw as Record<string, unknown>;
  const error = recurrenceError(r);
  if (error) return error;
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  // Resolve missing anchors from the task's date before building, so the stored
  // keys keep the same order sanitizeRecurrence writes after a load.
  const type = r.type as Recurrence["type"];
  const day =
    r.day !== undefined ? (r.day as number)
    : type === "monthly" || type === "yearly" ? d
    : undefined;
  const weekDow =
    r.dow !== undefined ? (r.dow as number)
    : type === "weekly" ? (dow === 0 ? 6 : dow - 1)
    : undefined;
  const month =
    r.month !== undefined ? (r.month as number)
    : type === "yearly" ? m
    : undefined;
  return {
    type,
    ...(day !== undefined && { day }),
    ...(weekDow !== undefined && { dow: weekDow }),
    ...(month !== undefined && { month }),
    ...((r.interval as number | undefined) !== undefined &&
      (r.interval as number) > 1 && { interval: r.interval as number }),
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
  const n = recurrence.interval ?? 1;

  if (rtype === "daily") {
    const next = new Date(date);
    next.setDate(next.getDate() + n);
    return formatDate(next);
  }

  if (rtype === "weekdays") {
    // Next Monday-to-Friday day: Friday +3, Saturday +2, otherwise +1.
    const currentDow = date.getDay() === 0 ? 6 : date.getDay() - 1;
    const next = new Date(date);
    next.setDate(next.getDate() + (currentDow >= 4 ? 7 - currentDow : 1));
    return formatDate(next);
  }

  if (rtype === "weekly") {
    const dow = recurrence.dow ?? (date.getDay() === 0 ? 6 : date.getDay() - 1);
    // Convert JS day (0=Sun) to Mon-based (0=Mon)
    const currentDow = date.getDay() === 0 ? 6 : date.getDay() - 1;
    // RFC 5545 FREQ=WEEKLY;INTERVAL=N;BYDAY: the next matching day, then N-1 more weeks.
    let daysAhead = dow - currentDow;
    if (daysAhead <= 0) daysAhead += 7;
    const next = new Date(date);
    next.setDate(next.getDate() + daysAhead + (n - 1) * 7);
    return formatDate(next);
  }

  if (rtype === "monthly") {
    const day = recurrence.day ?? d;
    const total = m - 1 + n;
    const nextYear = y + Math.floor(total / 12);
    const nextMonth = (total % 12) + 1;
    const maxDay = daysInMonth(nextYear, nextMonth);
    return `${nextYear}-${String(nextMonth).padStart(2, "0")}-${String(Math.min(day, maxDay)).padStart(2, "0")}`;
  }

  if (rtype === "yearly") {
    const month = recurrence.month ?? m;
    const day = recurrence.day ?? d;
    const nextYear = y + n;
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

function formatDateTimeBeforeRestore(d = new Date()): string {
  const datePart = formatDate(d);
  const timePart =
    String(d.getHours()).padStart(2, "0") +
    String(d.getMinutes()).padStart(2, "0") +
    String(d.getSeconds()).padStart(2, "0");
  return `${datePart}T${timePart}`;
}

function formatTimestampCorrupt(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${y}${m}${day}-${h}${min}${s}`;
}

function getCorruptPath(kind: "tasks" | "projects"): string {
  const baseTs = formatTimestampCorrupt();
  let filename = `${kind}.corrupt-${baseTs}.json`;
  let target = join(DATA_DIR, filename);
  let counter = 1;
  while (existsSync(target)) {
    filename = `${kind}.corrupt-${baseTs}-${counter}.json`;
    target = join(DATA_DIR, filename);
    counter++;
  }
  return target;
}

function applyRetention(kind: "tasks" | "projects"): void {
  if (!existsSync(BACKUPS_DIR)) return;
  const files = readdirSync(BACKUPS_DIR)
    .filter((f) => BACKUP_FILENAME_RE.exec(f)?.[1] === kind)
    .sort()
    .reverse();
  if (files.length > BACKUP_KEEP) {
    const toDelete = files.slice(BACKUP_KEEP);
    for (const f of toDelete) {
      try {
        unlinkSync(join(BACKUPS_DIR, f));
      } catch {}
    }
  }
}

function maybeDailyBackup(kind: "tasks" | "projects"): void {
  const filePath = kind === "tasks" ? TASKS_PATH : PROJECTS_PATH;
  if (!existsSync(filePath)) return;
  if (!existsSync(BACKUPS_DIR)) mkdirSync(BACKUPS_DIR, { recursive: true });

  const backupName = `${kind}-${today()}.json`;
  const backupPath = join(BACKUPS_DIR, backupName);
  if (!existsSync(backupPath)) {
    copyFileSync(filePath, backupPath);
    applyRetention(kind);
  }
}

function isValidTaskShape(raw: unknown): boolean {
  if (Array.isArray(raw)) return true;
  if (raw && typeof raw === "object" && "tasks" in raw && Array.isArray(raw.tasks)) {
    return true;
  }
  return false;
}

function isValidProjectShape(raw: unknown): boolean {
  if (Array.isArray(raw)) return true;
  if (raw && typeof raw === "object" && "projects" in raw && Array.isArray(raw.projects)) {
    return true;
  }
  return false;
}

function extractTaskArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && "tasks" in raw && Array.isArray(raw.tasks)) {
    return raw.tasks;
  }
  return [];
}

function extractProjectArray(raw: unknown): Project[] {
  if (Array.isArray(raw)) return raw as Project[];
  if (raw && typeof raw === "object" && "projects" in raw && Array.isArray(raw.projects)) {
    return raw.projects as Project[];
  }
  return [];
}

function getNewestReadableBackup(kind: "tasks" | "projects"): { file: string; data: unknown } | null {
  if (!existsSync(BACKUPS_DIR)) return null;
  const files = readdirSync(BACKUPS_DIR)
    .filter((f) => BACKUP_FILENAME_RE.exec(f)?.[1] === kind)
    .sort()
    .reverse();

  for (const file of files) {
    const fullPath = join(BACKUPS_DIR, file);
    try {
      const content = readFileSync(fullPath, "utf-8");
      const parsed = JSON.parse(content);
      if (kind === "tasks") {
        if (isValidTaskShape(parsed)) return { file, data: parsed };
      } else {
        if (isValidProjectShape(parsed)) return { file, data: parsed };
      }
    } catch {
      // unreadable, continue
    }
  }
  return null;
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
  let isCorrupt = false;
  let parsed: unknown = null;
  try {
    const raw = JSON.parse(readFileSync(TASKS_PATH, "utf-8"));
    if (!isValidTaskShape(raw)) {
      isCorrupt = true;
    } else {
      parsed = raw;
    }
  } catch {
    isCorrupt = true;
  }

  if (isCorrupt) {
    const corruptPath = getCorruptPath("tasks");
    renameSync(TASKS_PATH, corruptPath);
    console.log(`[bun-do] corrupted tasks file moved to ${corruptPath}`);

    const backup = getNewestReadableBackup("tasks");
    if (backup) {
      console.log(`[bun-do] loaded backup ${backup.file}`);
      const loaded = parseTasks(extractTaskArray(backup.data));
      const tmp = TASKS_PATH + ".tmp";
      writeFileSync(tmp, JSON.stringify(loaded, null, 2));
      renameSync(tmp, TASKS_PATH);
      return loaded;
    } else {
      console.log(`[bun-do] no readable backup found for tasks, starting with empty list`);
      const tmp = TASKS_PATH + ".tmp";
      writeFileSync(tmp, "[]");
      renameSync(tmp, TASKS_PATH);
      return [];
    }
  }

  return parseTasks(extractTaskArray(parsed));
}

function loadProjectsFromDisk(): Project[] {
  if (!existsSync(PROJECTS_PATH)) return [];
  let isCorrupt = false;
  let parsed: unknown = null;
  try {
    const raw = JSON.parse(readFileSync(PROJECTS_PATH, "utf-8"));
    if (!isValidProjectShape(raw)) {
      isCorrupt = true;
    } else {
      parsed = raw;
    }
  } catch {
    isCorrupt = true;
  }

  if (isCorrupt) {
    const corruptPath = getCorruptPath("projects");
    renameSync(PROJECTS_PATH, corruptPath);
    console.log(`[bun-do] corrupted projects file moved to ${corruptPath}`);

    const backup = getNewestReadableBackup("projects");
    if (backup) {
      console.log(`[bun-do] loaded backup ${backup.file}`);
      const arr = extractProjectArray(backup.data);
      const tmp = PROJECTS_PATH + ".tmp";
      writeFileSync(tmp, JSON.stringify(arr, null, 2));
      renameSync(tmp, PROJECTS_PATH);
      return arr;
    } else {
      console.log(`[bun-do] no readable backup found for projects, starting with empty list`);
      const tmp = PROJECTS_PATH + ".tmp";
      writeFileSync(tmp, "[]");
      renameSync(tmp, PROJECTS_PATH);
      return [];
    }
  }

  return extractProjectArray(parsed);
}

function saveTasks(): void {
  maybeDailyBackup("tasks");
  const tmp = TASKS_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(tasks, null, 2));
  renameSync(tmp, TASKS_PATH);
}

function saveProjects(): void {
  maybeDailyBackup("projects");
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
  const date = isoToDate(body.date);
  const recurrence = parseRecurrence(body.recurrence, date);
  if (typeof recurrence === "string") return json({ detail: recurrence }, 400);
  const newTask: Task = {
    id: crypto.randomUUID(),
    title: String(body.title ?? "").trim() || "Untitled task",
    date,
    priority: PRIORITY_LABELS.includes(body.priority) ? body.priority : "P2",
    notes: String(body.notes ?? "").trim(),
    done: false,
    type: TASK_TYPES.includes(body.type) ? body.type : "task",
    subtasks: [],
    recurrence,
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

  // Validate the rule first so a 400 leaves every field untouched.
  const recurrence = body.recurrence === undefined
    ? undefined
    : parseRecurrence(body.recurrence, body.date === undefined ? task.date : isoToDate(body.date));
  if (typeof recurrence === "string") return json({ detail: recurrence }, 400);

  if (body.title !== undefined) task.title = String(body.title).trim() || task.title;
  if (body.date !== undefined) task.date = isoToDate(body.date);
  if (body.priority !== undefined && PRIORITY_LABELS.includes(body.priority)) task.priority = body.priority;
  if (body.notes !== undefined) task.notes = String(body.notes).trim();
  if (body.type !== undefined && TASK_TYPES.includes(body.type)) task.type = body.type;
  if (body.amount !== undefined) task.amount = String(body.amount).trim();
  if (body.currency !== undefined && CURRENCIES.includes(body.currency)) task.currency = body.currency;
  if (body.tags !== undefined) task.tags = normalizeTags(body.tags);
  if (recurrence !== undefined) task.recurrence = recurrence;
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

// -- Backups --

interface BackupInfo {
  name: string;
  file: string;
  kind: "tasks" | "projects";
  date: string;
  size: number;
  entries: number;
  count: number;
}

function handleGetBackups(): Response {
  if (!existsSync(BACKUPS_DIR)) {
    return json({ backups: [] });
  }

  const files = readdirSync(BACKUPS_DIR)
    .filter((f) => BACKUP_FILENAME_RE.test(f))
    .sort((a, b) => {
      const ka = a.replace(/^(tasks|projects)-/, "");
      const kb = b.replace(/^(tasks|projects)-/, "");
      return kb.localeCompare(ka) || a.localeCompare(b);
    });

  const backups: BackupInfo[] = [];

  for (const file of files) {
    const fullPath = join(BACKUPS_DIR, file);
    try {
      const stat = statSync(fullPath);
      const m = file.match(BACKUP_FILENAME_RE);
      if (!m) continue;
      const kind = m[1] as "tasks" | "projects";
      const datePart = m[2];
      const sub = m[3] ?? "";
      let date = datePart;
      if (sub.startsWith("T")) {
        const timeStr = sub.slice(1, 7);
        date = `${datePart} ${timeStr.slice(0, 2)}:${timeStr.slice(2, 4)}:${timeStr.slice(4, 6)}`;
      }

      let entries = 0;
      try {
        const content = readFileSync(fullPath, "utf-8");
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          entries = parsed.length;
        } else if (parsed && typeof parsed === "object") {
          if ("tasks" in parsed && Array.isArray(parsed.tasks)) entries = parsed.tasks.length;
          else if ("projects" in parsed && Array.isArray(parsed.projects)) entries = parsed.projects.length;
        }
      } catch {}

      backups.push({
        name: file,
        file,
        kind,
        date,
        size: stat.size,
        entries,
        count: entries,
      });
    } catch {}
  }

  return json({ backups });
}

async function handleRestoreBackup(req: Request): Promise<Response> {
  const body: unknown = await parseJson(req);
  if (!body || typeof body !== "object" || !("file" in body)) {
    return json({ detail: "file is required" }, 400);
  }
  const file = body.file;
  if (typeof file !== "string" || !file) {
    return json({ detail: "file is required" }, 400);
  }

  if (file.includes("/") || file.includes("\\") || file.includes("..")) {
    return json({ detail: "file must be a bare file name without path" }, 400);
  }

  const match = file.match(BACKUP_FILENAME_RE);
  if (!match) {
    return json({ detail: "file name must match the backup pattern" }, 400);
  }

  const backupPath = join(BACKUPS_DIR, file);
  if (!existsSync(backupPath)) {
    return notFound("Backup file not found");
  }

  let parsed: unknown;
  try {
    const content = readFileSync(backupPath, "utf-8");
    parsed = JSON.parse(content);
  } catch {
    return json({ detail: "Backup file is unreadable or not valid JSON" }, 400);
  }

  const kind = match[1] as "tasks" | "projects";
  if (kind === "tasks") {
    if (!isValidTaskShape(parsed)) {
      return json({ detail: "Backup file has invalid shape for tasks" }, 400);
    }
  } else {
    if (!isValidProjectShape(parsed)) {
      return json({ detail: "Backup file has invalid shape for projects" }, 400);
    }
  }

  if (!existsSync(BACKUPS_DIR)) mkdirSync(BACKUPS_DIR, { recursive: true });
  const beforeRestoreName = `${kind}-${formatDateTimeBeforeRestore()}-before-restore.json`;
  const beforeRestorePath = join(BACKUPS_DIR, beforeRestoreName);
  const currentPath = kind === "tasks" ? TASKS_PATH : PROJECTS_PATH;
  if (existsSync(currentPath)) {
    copyFileSync(currentPath, beforeRestorePath);
  } else {
    const currentData = kind === "tasks" ? tasks : projects;
    writeFileSync(beforeRestorePath, JSON.stringify(currentData, null, 2));
  }
  applyRetention(kind);

  if (kind === "tasks") {
    tasks = parseTasks(extractTaskArray(parsed));
    const tmp = TASKS_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(tasks, null, 2));
    renameSync(tmp, TASKS_PATH);
  } else {
    projects = extractProjectArray(parsed);
    const tmp = PROJECTS_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(projects, null, 2));
    renameSync(tmp, PROJECTS_PATH);
  }

  return json({ ok: true, restored: file });
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


  if (path === "/api/backups" && method === "GET") return handleGetBackups();
  if (path === "/api/backups/restore" && method === "POST") return handleRestoreBackup(req);
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
