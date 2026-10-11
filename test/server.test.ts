import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { api, localDate, startServer, type TestServer } from "./helpers";

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(() => server.stop());

describe("tasks", () => {
  test("create fills defaults and lists the task", async () => {
    const created = await api(server, "POST", "/api/tasks", { title: "  Buy milk  " });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      title: "Buy milk",
      priority: "P2",
      type: "task",
      done: false,
      subtasks: [],
      recurrence: null,
      currency: "CHF",
    });

    const list = await api(server, "GET", "/api/tasks");
    expect(list.body.tasks.map((t: { id: string }) => t.id)).toContain(created.body.id);
  });

  test("create rejects unknown values and keeps safe defaults", async () => {
    const created = await api(server, "POST", "/api/tasks", {
      title: "",
      priority: "P9",
      type: "meeting",
      date: "2026-02-30",
      currency: "XYZ",
    });
    expect(created.body.title).toBe("Untitled task");
    expect(created.body.priority).toBe("P2");
    expect(created.body.type).toBe("task");
    expect(created.body.currency).toBe("CHF");
    expect(created.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("update changes only the fields sent", async () => {
    const { body: task } = await api(server, "POST", "/api/tasks", {
      title: "Report",
      priority: "P1",
      notes: "draft",
    });
    const updated = await api(server, "PUT", `/api/tasks/${task.id}`, { priority: "P0" });
    expect(updated.body).toMatchObject({ title: "Report", priority: "P0", notes: "draft" });

    const ignored = await api(server, "PUT", `/api/tasks/${task.id}`, { priority: "urgent" });
    expect(ignored.body.priority).toBe("P0");
  });

  test("delete removes the task and a second delete is 404", async () => {
    const { body: task } = await api(server, "POST", "/api/tasks", { title: "Temp" });
    expect((await api(server, "DELETE", `/api/tasks/${task.id}`)).status).toBe(200);
    expect((await api(server, "DELETE", `/api/tasks/${task.id}`)).status).toBe(404);
    expect((await api(server, "PUT", `/api/tasks/${task.id}`, { done: true })).status).toBe(404);
  });

  test("invalid JSON is a 400", async () => {
    const res = await api(server, "POST", "/api/tasks", "{not json");
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe("Invalid JSON");
  });

  test("reorder needs a string array", async () => {
    expect((await api(server, "POST", "/api/tasks/reorder", { ids: [1, 2] })).status).toBe(400);
    const { body: a } = await api(server, "POST", "/api/tasks", { title: "A" });
    const { body: b } = await api(server, "POST", "/api/tasks", { title: "B" });
    expect((await api(server, "POST", "/api/tasks/reorder", { ids: [b.id, a.id] })).status).toBe(200);
    const list = await api(server, "GET", "/api/tasks");
    const order = (id: string) => list.body.tasks.find((t: { id: string }) => t.id === id).sort_order;
    expect(order(b.id)).toBe(0);
    expect(order(a.id)).toBe(1);
  });

  test("clear-done removes only finished tasks", async () => {
    const { body: done } = await api(server, "POST", "/api/tasks", { title: "Finished" });
    const { body: open } = await api(server, "POST", "/api/tasks", { title: "Open" });
    await api(server, "PUT", `/api/tasks/${done.id}`, { done: true });
    const res = await api(server, "POST", "/api/tasks/clear-done");
    expect(res.body.cleared).toBeGreaterThanOrEqual(1);
    const ids = (await api(server, "GET", "/api/tasks")).body.tasks.map((t: { id: string }) => t.id);
    expect(ids).toContain(open.id);
    expect(ids).not.toContain(done.id);
  });

  test("tasks persist to tasks.json", async () => {
    const { body: task } = await api(server, "POST", "/api/tasks", { title: "Saved on disk" });
    const onDisk = JSON.parse(readFileSync(join(server.dataDir, "tasks.json"), "utf-8"));
    expect(onDisk.map((t: { id: string }) => t.id)).toContain(task.id);
  });
});

describe("recurrence", () => {
  async function completeAndFindNext(body: Record<string, unknown>) {
    const { body: task } = await api(server, "POST", "/api/tasks", body);
    await api(server, "PUT", `/api/tasks/${task.id}`, { done: true });
    const list = (await api(server, "GET", "/api/tasks")).body.tasks;
    return list.find((t: { id: string; title: string; done: boolean }) => t.title === body.title && !t.done);
  }

  test("monthly on the 31st clamps to the end of a short month", async () => {
    const next = await completeAndFindNext({
      title: "Rent",
      date: "2026-01-31",
      recurrence: { type: "monthly", day: 31 },
    });
    expect(next.date).toBe("2026-02-28");
    expect(next.recurrence).toEqual({ type: "monthly", day: 31 });
  });

  test("weekly moves to the next given weekday (0 = Monday)", async () => {
    // 2026-10-07 is a Wednesday; the next Monday is 2026-10-12.
    const next = await completeAndFindNext({
      title: "Standup",
      date: "2026-10-07",
      recurrence: { type: "weekly", dow: 0 },
    });
    expect(next.date).toBe("2026-10-12");
  });

  test("yearly on 29 February falls back to the 28th", async () => {
    const next = await completeAndFindNext({
      title: "Leap",
      date: "2028-02-29",
      recurrence: { type: "yearly", month: 2, day: 29 },
    });
    expect(next.date).toBe("2029-02-28");
  });

  test("the next occurrence copies subtasks as not done", async () => {
    const { body: task } = await api(server, "POST", "/api/tasks", {
      title: "Checklist",
      date: "2026-03-02",
      recurrence: { type: "weekly", dow: 0 },
    });
    await api(server, "POST", `/api/tasks/${task.id}/subtasks`, { title: "Step" });
    const sub = (await api(server, "GET", "/api/tasks")).body.tasks.find((t: { id: string }) => t.id === task.id)
      .subtasks[0];
    await api(server, "PUT", `/api/tasks/${task.id}/subtasks/${sub.id}`, { done: true });
    await api(server, "PUT", `/api/tasks/${task.id}`, { done: true });
    const next = (await api(server, "GET", "/api/tasks")).body.tasks.find(
      (t: { title: string; done: boolean }) => t.title === "Checklist" && !t.done,
    );
    expect(next.subtasks).toHaveLength(1);
    expect(next.subtasks[0].done).toBe(false);
    expect(next.subtasks[0].id).not.toBe(sub.id);
  });
});

describe("carry-over", () => {
  test("open past tasks move to today; payments and recurring tasks keep their date", async () => {
    const past = "2020-01-15";
    const { body: plain } = await api(server, "POST", "/api/tasks", { title: "Old", date: past });
    const { body: payment } = await api(server, "POST", "/api/tasks", { title: "Bill", date: past, type: "payment" });
    const { body: recurring } = await api(server, "POST", "/api/tasks", {
      title: "Habit",
      date: past,
      recurrence: { type: "weekly", dow: 2 },
    });
    const list = await api(server, "GET", "/api/tasks");
    const byId = (id: string) => list.body.tasks.find((t: { id: string }) => t.id === id);
    expect(list.body.carried_over).toBeGreaterThanOrEqual(1);
    expect(byId(plain.id).date).not.toBe(past);
    expect(byId(payment.id).date).toBe(past);
    expect(byId(recurring.id).date).toBe(past);
  });
});

describe("subtasks", () => {
  test("add, rename, reorder and delete", async () => {
    const { body: task } = await api(server, "POST", "/api/tasks", { title: "Trip" });
    const { body: a } = await api(server, "POST", `/api/tasks/${task.id}/subtasks`, { title: "Tickets" });
    const { body: b } = await api(server, "POST", `/api/tasks/${task.id}/subtasks`, { title: "Hotel" });

    const renamed = await api(server, "PUT", `/api/tasks/${task.id}/subtasks/${a.id}`, { title: "Train tickets" });
    expect(renamed.body.title).toBe("Train tickets");

    await api(server, "POST", `/api/tasks/${task.id}/subtasks/reorder`, { ids: [b.id, a.id] });
    let subs = (await api(server, "GET", "/api/tasks")).body.tasks.find((t: { id: string }) => t.id === task.id)
      .subtasks;
    expect(subs.map((s: { id: string }) => s.id)).toEqual([b.id, a.id]);

    expect((await api(server, "DELETE", `/api/tasks/${task.id}/subtasks/${b.id}`)).status).toBe(200);
    expect((await api(server, "DELETE", `/api/tasks/${task.id}/subtasks/${b.id}`)).status).toBe(404);
    subs = (await api(server, "GET", "/api/tasks")).body.tasks.find((t: { id: string }) => t.id === task.id).subtasks;
    expect(subs.map((s: { id: string }) => s.id)).toEqual([a.id]);
  });
});

describe("projects", () => {
  test("create, update, log entries and delete", async () => {
    const created = await api(server, "POST", "/api/projects", {
      name: "Thesis",
      repo: "javascript:alert(1)",
      description: "PhD",
    });
    expect(created.body).toMatchObject({ name: "Thesis", repo: "", status: "active", entries: [] });
    const id = created.body.id;

    const updated = await api(server, "PUT", `/api/projects/${id}`, {
      status: "paused",
      repo: "https://github.com/example/thesis",
    });
    expect(updated.body).toMatchObject({ status: "paused", repo: "https://github.com/example/thesis" });
    expect((await api(server, "PUT", `/api/projects/${id}`, { status: "gone" })).body.status).toBe("paused");

    const entry = await api(server, "POST", `/api/projects/${id}/entries`, { summary: "Chapter 1", date: "2026-10-01" });
    expect(entry.body).toMatchObject({ summary: "Chapter 1", date: "2026-10-01" });
    expect((await api(server, "DELETE", `/api/projects/${id}/entries/${entry.body.id}`)).status).toBe(200);

    expect((await api(server, "DELETE", `/api/projects/${id}`)).status).toBe(200);
    expect((await api(server, "GET", "/api/projects")).body.projects).toEqual([]);
  });
});

describe("static files and routing", () => {
  test("serves the app and vendored scripts", async () => {
    const page = await fetch(server.base + "/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const script = await fetch(server.base + "/static/alpine.min.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("application/javascript");
  });

  test("does not serve files outside static/", async () => {
    const res = await fetch(server.base + "/static/..%2fserver.ts");
    expect(res.status).not.toBe(200);
  });

  test("unknown routes are 404", async () => {
    expect((await fetch(server.base + "/api/nothing")).status).toBe(404);
  });
});

describe("request checks", () => {
  test("a foreign Host header is refused (DNS rebinding)", async () => {
    for (const path of ["/api/tasks", "/api/projects", "/"]) {
      const res = await fetch(server.base + path, { headers: { Host: `attacker.example:${server.port}` } });
      expect(res.status).toBe(403);
    }
  });

  test("localhost and 127.0.0.1 Host headers are accepted", async () => {
    for (const host of [`localhost:${server.port}`, `127.0.0.1:${server.port}`]) {
      const res = await fetch(server.base + "/api/tasks", { headers: { Host: host } });
      expect(res.status).toBe(200);
    }
  });

  test("writes from the app's own origin are accepted, on either loopback name", async () => {
    for (const host of [`localhost:${server.port}`, `127.0.0.1:${server.port}`]) {
      const res = await api(server, "POST", "/api/tasks", { title: `From ${host}` }, {
        Host: host,
        Origin: `http://${host}`,
      });
      expect(res.status).toBe(200);
    }
  });

  test("writes without an Origin header are accepted (curl, MCP)", async () => {
    expect((await api(server, "POST", "/api/tasks", { title: "From curl" })).status).toBe(200);
  });

  test("writes from another origin are refused", async () => {
    const origins = ["http://attacker.example", `http://localhost:${server.port + 1}`, "null"];
    for (const origin of origins) {
      const res = await api(server, "POST", "/api/tasks", { title: "CSRF" }, { Origin: origin });
      expect(res.status).toBe(403);
    }
    const { body: task } = await api(server, "POST", "/api/tasks", { title: "Victim" });
    const del = await api(server, "DELETE", `/api/tasks/${task.id}`, undefined, { Origin: "http://attacker.example" });
    expect(del.status).toBe(403);
  });
});

describe("dates follow the local time zone", () => {
  // Pick a zone whose calendar date differs from the UTC date right now, so a server that
  // uses the UTC date fails. Kiritimati is UTC+14, Pago Pago is UTC-11.
  const zone = new Date().getUTCHours() >= 10 ? "Pacific/Kiritimati" : "Pacific/Pago_Pago";
  let zoned: TestServer;

  beforeAll(async () => {
    zoned = await startServer({ env: { TZ: zone } });
  });

  afterAll(() => zoned.stop());

  test(`a task without a date gets today's date in ${zone}`, async () => {
    expect(localDate(zone)).not.toBe(new Date().toISOString().slice(0, 10));
    const { body } = await api(zoned, "POST", "/api/tasks", { title: "Today" });
    expect(body.date).toBe(localDate(zone));
  });

  test(`yesterday's open task carries to today in ${zone}`, async () => {
    const yesterday = localDate(zone, -1);
    const { body: task } = await api(zoned, "POST", "/api/tasks", { title: "Late", date: yesterday });
    const list = await api(zoned, "GET", "/api/tasks");
    expect(list.body.tasks.find((t: { id: string }) => t.id === task.id).date).toBe(localDate(zone));
  });
});

describe("tags", () => {
  test("a task file without tags loads as an empty list", async () => {
    const old = await startServer({
      tasks: [{
        id: "old",
        title: "Pre-1.5",
        date: "2026-01-05",
        priority: "P1",
        notes: "",
        done: false,
        type: "task",
        subtasks: [],
        recurrence: null,
        sort_order: 0,
        amount: "",
        currency: "CHF",
      }],
    });
    try {
      const list = await api(old, "GET", "/api/tasks");
      expect(list.body.tasks.find((t: { id: string }) => t.id === "old").tags).toEqual([]);
    } finally {
      old.stop();
    }
  });

  test("create normalises a comma string, unicode, length and duplicates", async () => {
    const comma = await api(server, "POST", "/api/tasks", {
      title: "Comma tags",
      tags: " #Travel, Work ,travel,,",
    });
    expect(comma.body.tags).toEqual(["travel", "work"]);

    const many = Array.from({ length: 12 }, (_, i) => `Tag Number ${i} ` + "x".repeat(40));
    const capped = await api(server, "POST", "/api/tasks", { title: "Many tags", tags: many });
    expect(capped.body.tags).toHaveLength(10);
    expect(capped.body.tags.every((t: string) => t.length <= 32 && !/\s|[A-Z]/.test(t))).toBe(true);

    const unicode = await api(server, "POST", "/api/tasks", {
      title: "Unicode tags",
      tags: [" Café!", "naïve", "café"],
    });
    expect(unicode.body.tags).toEqual(["café", "naïve"]);

    const spaced = await api(server, "POST", "/api/tasks", { title: "Spaced", tags: ["# Home", "#  Deep  Work "] });
    expect(spaced.body.tags).toEqual(["home", "deep-work"]);
  });

  test("update replaces the list and omitting tags keeps them", async () => {
    const { body: task } = await api(server, "POST", "/api/tasks", { title: "Keep tags", tags: ["home"] });
    const kept = await api(server, "PUT", `/api/tasks/${task.id}`, { notes: "x" });
    expect(kept.body.tags).toEqual(["home"]);
    const replaced = await api(server, "PUT", `/api/tasks/${task.id}`, { tags: ["Home"] });
    expect(replaced.body.tags).toEqual(["home"]);
    const cleared = await api(server, "PUT", `/api/tasks/${task.id}`, { tags: "" });
    expect(cleared.body.tags).toEqual([]);
  });

  test("?tag= returns only tasks carrying the normalised tag", async () => {
    const marked = await api(server, "POST", "/api/tasks", { title: "Marked work", tags: ["work"] });
    const plain = await api(server, "POST", "/api/tasks", { title: "Plain no work tag" });
    for (const q of ["work", "%23WORK"]) {
      const got = await api(server, "GET", `/api/tasks?tag=${q}`);
      expect(got.body.tasks.length).toBeGreaterThan(0);
      expect(got.body.tasks.every((t: { tags: string[] }) => t.tags.includes("work"))).toBe(true);
      expect(got.body.tasks.map((t: { id: string }) => t.id)).toContain(marked.body.id);
      expect(got.body.tasks.map((t: { id: string }) => t.id)).not.toContain(plain.body.id);
    }
    const all = await api(server, "GET", "/api/tasks");
    expect(all.body.tasks.map((t: { id: string }) => t.id)).toContain(plain.body.id);
    expect(all.body.carried_over).toEqual(expect.any(Number));
  });

  test("the next occurrence keeps the tags", async () => {
    const { body: task } = await api(server, "POST", "/api/tasks", {
      title: "Gym tags",
      tags: ["health"],
      date: "2026-11-02",
      recurrence: { type: "weekly", dow: 0 },
    });
    await api(server, "PUT", `/api/tasks/${task.id}`, { done: true });
    const next = (await api(server, "GET", "/api/tasks")).body.tasks.find(
      (t: { title: string; done: boolean }) => t.title === "Gym tags" && !t.done,
    );
    expect(next.tags).toEqual(["health"]);
  });
});
