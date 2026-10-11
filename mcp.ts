#!/usr/bin/env bun
// bun-do MCP server — exposes bun-do REST API as MCP tools over stdio (JSON-RPC 2.0)
// Usage: add to .mcp.json → { "bun-do": { "command": "bun-do-mcp" } }

import { createInterface } from "readline";
import { readFileSync } from "fs";
import { join } from "path";

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf-8"));
// 127.0.0.1, not localhost: the server listens on IPv4 loopback only, and localhost can resolve to ::1.
const BASE = `http://127.0.0.1:${process.env.BUNDO_PORT || 8000}`;

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} → HTTP ${res.status}${text ? ": " + text : ""}`);
  }
  return res.json();
}

const TOOLS = [
  {
    name: "list_tasks",
    description:
      "List tasks from bun-do. Returns tasks with id, title, date, priority, type, done, notes, subtasks, tags. Optional tag returns only tasks carrying that tag.",
    inputSchema: {
      type: "object",
      properties: {
        tag: {
          type: "string",
          description:
            "Only tasks carrying this tag. Normalised the same way as task tags: trimmed, leading # removed, lower case.",
        },
      },
      required: [],
    },
  },
  {
    name: "add_task",
    description: "Create a new task in bun-do.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title (required)" },
        date: { type: "string", description: "Due date YYYY-MM-DD (default: today)" },
        priority: {
          type: "string",
          enum: ["P0", "P1", "P2", "P3"],
          description: "Priority — P0 critical, P1 high, P2 normal, P3 backlog (default: P2)",
        },
        type: {
          type: "string",
          enum: ["task", "deadline", "reminder", "payment"],
          description: "Task type (default: task)",
        },
        notes: { type: "string", description: "Optional notes" },
        tags: {
          description:
            "Tags as an array of strings, or one comma-separated string. Each tag is trimmed, a leading # is removed, lower-cased, whitespace runs become -, and only letters, digits, - and _ are kept. At most 32 characters, at most 10 per task, duplicates dropped (first wins).",
          anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }],
        },
        recurrence: {
          description:
            "Recurrence rule, or null for none. weekly uses dow (0 = Monday .. 6 = Sunday); monthly uses day (1-31); yearly uses month (1-12) and day.",
          anyOf: [
            { type: "null" },
            {
              type: "object",
              properties: {
                type: { type: "string", enum: ["weekly", "monthly", "yearly"] },
                dow: { type: "number", description: "Weekday for weekly, 0 = Monday .. 6 = Sunday" },
                day: { type: "number", description: "Day of month for monthly or yearly, 1-31" },
                month: { type: "number", description: "Month for yearly, 1-12" },
              },
              required: ["type"],
            },
          ],
        },
        amount: { type: "string", description: "Payment amount, stored as text" },
        currency: {
          type: "string",
          enum: ["CHF", "USD", "EUR", "BRL"],
          description: "Payment currency (default CHF)",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "update_task",
    description: "Update an existing task. Only send the fields you want to change.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task UUID" },
        title: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
        type: { type: "string", enum: ["task", "deadline", "reminder", "payment"] },
        done: { type: "boolean", description: "Mark task done or not done" },
        notes: { type: "string" },
        tags: {
          description:
            "Replaces the tag list. An array of strings, or one comma-separated string. Same normalisation as add_task.",
          anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }],
        },
        recurrence: {
          description:
            "Replaces the recurrence rule. Null clears it. weekly uses dow (0 = Monday .. 6 = Sunday); monthly uses day; yearly uses month and day.",
          anyOf: [
            { type: "null" },
            {
              type: "object",
              properties: {
                type: { type: "string", enum: ["weekly", "monthly", "yearly"] },
                dow: { type: "number" },
                day: { type: "number" },
                month: { type: "number" },
              },
              required: ["type"],
            },
          ],
        },
        amount: { type: "string", description: "Payment amount, stored as text" },
        currency: { type: "string", enum: ["CHF", "USD", "EUR", "BRL"] },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_task",
    description: "Delete a task by its UUID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task UUID" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_projects",
    description: "List all projects from bun-do, including their progress log entries.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "add_project_entry",
    description: "Add a timestamped progress log entry to a project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        summary: { type: "string", description: "Progress summary text" },
      },
      required: ["project_id", "summary"],
    },
  },
];

async function handleCall(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "list_tasks": {
      const tag = typeof args.tag === "string" && args.tag !== "" ? `?tag=${encodeURIComponent(args.tag)}` : "";
      return JSON.stringify(await api("GET", `/api/tasks${tag}`), null, 2);
    }
    case "add_task":
      return JSON.stringify(await api("POST", "/api/tasks", args), null, 2);
    case "update_task": {
      const { id, ...fields } = args;
      return JSON.stringify(await api("PUT", `/api/tasks/${id}`, fields), null, 2);
    }
    case "delete_task":
      return JSON.stringify(await api("DELETE", `/api/tasks/${args.id}`), null, 2);
    case "list_projects":
      return JSON.stringify(await api("GET", "/api/projects"), null, 2);
    case "add_project_entry": {
      const { project_id, ...fields } = args;
      return JSON.stringify(
        await api("POST", `/api/projects/${project_id}/entries`, fields),
        null,
        2
      );
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const rl = createInterface({ input: process.stdin, terminal: false });

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;

  let msg: { jsonrpc: string; id?: number | string; method: string; params?: unknown };
  try {
    msg = JSON.parse(trimmed);
  } catch {
    continue;
  }

  const { id, method, params } = msg;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "bun-do", version: pkg.version },
      },
    });
  } else if (method === "notifications/initialized") {
    // notification — no response
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  } else if (method === "ping" && id !== undefined) {
    send({ jsonrpc: "2.0", id, result: {} });
  } else if (method === "tools/call") {
    try {
      const { name, arguments: args = {} } = (params ?? {}) as {
        name: string;
        arguments?: Record<string, unknown>;
      };
      const text = await handleCall(name, args);
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: message }], isError: true },
      });
    }
  } else if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}
