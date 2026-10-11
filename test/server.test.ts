import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
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
  test("daily repeats every N days", async () => {
    const next = await completeAndFindNext({
      title: "Water plants",
      date: "2026-10-09",
      recurrence: { type: "daily", interval: 3 },
    });
    expect(next.date).toBe("2026-10-12");
    expect(next.recurrence).toEqual({ type: "daily", interval: 3 });
  });

  test("weekdays goes to the next Monday-to-Friday day", async () => {
    // 2026-10-09 Friday, 10 Saturday, 11 Sunday, 12 Monday.
    for (const [date, want] of [
      ["2026-10-09", "2026-10-12"],
      ["2026-10-10", "2026-10-12"],
      ["2026-10-11", "2026-10-12"],
      ["2026-10-12", "2026-10-13"],
    ]) {
      const next = await completeAndFindNext({ title: `Standup ${date}`, date, recurrence: { type: "weekdays" } });
      expect(next.date).toBe(want);
    }
  });

  test("weekly with an interval lands on the target weekday N weeks out", async () => {
    // 2026-10-12 is a Monday: next Monday, then one more week.
    const next = await completeAndFindNext({
      title: "Biweekly review",
      date: "2026-10-12",
      recurrence: { type: "weekly", dow: 0, interval: 2 },
    });
    expect(next.date).toBe("2026-10-26");
    expect(next.recurrence).toEqual({ type: "weekly", dow: 0, interval: 2 });
  });

  test("monthly with an interval clamps to the end of the target month", async () => {
    const next = await completeAndFindNext({
      title: "Quarterly rent",
      date: "2026-01-31",
      recurrence: { type: "monthly", day: 31, interval: 3 },
    });
    expect(next.date).toBe("2026-04-30");
    expect(next.recurrence).toEqual({ type: "monthly", day: 31, interval: 3 });
  });

  test("monthly crosses the year end and keeps its anchor", async () => {
    const next = await completeAndFindNext({
      title: "Bimonthly bill",
      date: "2026-11-30",
      recurrence: { type: "monthly", day: 30, interval: 2 },
    });
    expect(next.date).toBe("2027-01-30");
  });

  test("yearly with an interval clamps a leap day in a non-leap year", async () => {
    const next = await completeAndFindNext({
      title: "Leapiversary",
      date: "2028-02-29",
      recurrence: { type: "yearly", month: 2, day: 29, interval: 2 },
    });
    expect(next.date).toBe("2030-02-28");
    expect(next.recurrence).toEqual({ type: "yearly", month: 2, day: 29, interval: 2 });
  });

  test("a rule without its anchor takes it from the task's date", async () => {
    const { body: monthly } = await api(server, "POST", "/api/tasks", {
      title: "Anchored monthly",
      date: "2026-01-31",
      recurrence: { type: "monthly" },
    });
    expect(monthly.recurrence).toEqual({ type: "monthly", day: 31 });

    const { body: yearly } = await api(server, "POST", "/api/tasks", {
      title: "Anchored yearly",
      date: "2028-02-29",
      recurrence: { type: "yearly" },
    });
    expect(yearly.recurrence).toEqual({ type: "yearly", month: 2, day: 29 });

    // 2026-10-07 is a Wednesday, dow 2.
    const { body: weekly } = await api(server, "POST", "/api/tasks", {
      title: "Anchored weekly",
      date: "2026-10-07",
      recurrence: { type: "weekly" },
    });
    expect(weekly.recurrence).toEqual({ type: "weekly", dow: 2 });

    const updated = await api(server, "PUT", `/api/tasks/${monthly.id}`, { recurrence: { type: "yearly" } });
    expect(updated.body.recurrence).toEqual({ type: "yearly", month: 1, day: 31 });
  });

  test("the anchored monthly rule does not drift after a short month", async () => {
    const { body: task } = await api(server, "POST", "/api/tasks", {
      title: "No drift",
      date: "2026-01-31",
      recurrence: { type: "monthly" },
    });
    await api(server, "PUT", `/api/tasks/${task.id}`, { done: true });
    const feb = (await api(server, "GET", "/api/tasks")).body.tasks.find(
      (t: { title: string; done: boolean }) => t.title === "No drift" && !t.done,
    );
    expect(feb.date).toBe("2026-02-28");
    expect(feb.recurrence).toEqual({ type: "monthly", day: 31 });
    await api(server, "PUT", `/api/tasks/${feb.id}`, { done: true });
    const mar = (await api(server, "GET", "/api/tasks")).body.tasks.find(
      (t: { title: string; done: boolean }) => t.title === "No drift" && !t.done,
    );
    expect(mar.date).toBe("2026-03-31");
  });

  test("create and update refuse an invalid rule with a 400 detail", async () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ type: "hourly" }, "type", "daily"],
      [{ type: "daily", interval: 0 }, "interval", "99"],
      [{ type: "daily", interval: 100 }, "interval", "99"],
      [{ type: "daily", interval: 1.5 }, "interval", "whole"],
      [{ type: "weekly", dow: 7 }, "dow", "6"],
      [{ type: "monthly", day: 32 }, "day", "31"],
      [{ type: "yearly", month: 13, day: 1 }, "month", "12"],
      [{ type: "weekdays", interval: 2 }, "interval", "1"],
    ];
    for (const [rule, field, allowed] of cases) {
      const res = await api(server, "POST", "/api/tasks", { title: "Bad", recurrence: rule });
      expect(res.status).toBe(400);
      expect(res.body.detail).toContain(`recurrence.${field}`);
      expect(res.body.detail).toContain(allowed);
    }

    const { body: task } = await api(server, "POST", "/api/tasks", { title: "Victim", notes: "keep me" });
    const res = await api(server, "PUT", `/api/tasks/${task.id}`, {
      notes: "must not be saved",
      recurrence: { type: "daily", interval: 0 },
    });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain("recurrence.interval");
    const fresh = (await api(server, "GET", "/api/tasks")).body.tasks.find(
      (t: { id: string }) => t.id === task.id,
    );
    expect(fresh.notes).toBe("keep me");

    const cleared = await api(server, "PUT", `/api/tasks/${task.id}`, { recurrence: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.recurrence).toBeNull();
  });

  test("interval 1 is not stored and an update without recurrence keeps it", async () => {
    const { body: task } = await api(server, "POST", "/api/tasks", {
      title: "Interval one",
      date: "2026-10-07",
      recurrence: { type: "weekly", interval: 1 },
    });
    expect(task.recurrence).toEqual({ type: "weekly", dow: 2 });

    const renamed = await api(server, "PUT", `/api/tasks/${task.id}`, { title: "Renamed" });
    expect(renamed.body.recurrence).toEqual({ type: "weekly", dow: 2 });
  });

});

describe("recurrence loading", () => {
  test("an invalid stored rule loads as null and the file still loads", async () => {
    const seeded = await startServer({
      tasks: [
        { id: "bad-type", title: "Bad type", date: "2026-01-31", recurrence: { type: "hourly" } },
        { id: "bad-day", title: "Bad day", date: "2026-01-31", recurrence: { type: "monthly", day: 32 } },
        { id: "bad-shape", title: "Not an object", date: "2026-01-31", recurrence: "weekly" },
        { id: "old", title: "Old monthly", date: "2026-01-31", recurrence: { type: "monthly", day: 31 } },
      ],
    });
    try {
      const { body } = await api(seeded, "GET", "/api/tasks");
      const byId = (id: string) => body.tasks.find((t: { id: string }) => t.id === id);
      expect(byId("bad-type").recurrence).toBeNull();
      expect(byId("bad-day").recurrence).toBeNull();
      expect(byId("bad-shape").recurrence).toBeNull();
      // A stored pre-1.5 rule keeps its exact shape and meaning.
      expect(byId("old").recurrence).toEqual({ type: "monthly", day: 31 });
    } finally {
      seeded.stop();
    }
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

describe("backups", () => {
  test("snapshot once a day saves state before first write and keeps it on second write", async () => {
    const s = await startServer({ tasks: [{ id: "t1", title: "Initial Task", date: "2026-01-01" }] });
    try {
      const todayStr = localDate(Intl.DateTimeFormat().resolvedOptions().timeZone);
      const backupFile = join(s.dataDir, "backups", `tasks-${todayStr}.json`);

      // First write of the day
      await api(s, "POST", "/api/tasks", { title: "Second Task" });
      expect(existsSync(backupFile)).toBe(true);
      const content1 = readFileSync(backupFile, "utf-8");
      expect(content1).toContain("Initial Task");
      expect(content1).not.toContain("Second Task");

      // Second write of the day does not replace the snapshot
      await api(s, "POST", "/api/tasks", { title: "Third Task" });
      const content2 = readFileSync(backupFile, "utf-8");
      expect(content2).toContain("Initial Task");
      expect(content2).not.toContain("Third Task");
    } finally {
      s.stop();
    }
  });

  test("retention keeps newest BUNDO_BACKUP_KEEP files and deletes older ones", async () => {
    const s = await startServer({
      tasks: [{ id: "t1", title: "Task 1" }],
      env: { BUNDO_BACKUP_KEEP: "3" },
    });
    try {
      const bdir = join(s.dataDir, "backups");
      mkdirSync(bdir, { recursive: true });
      for (const d of ["01", "02", "03", "04", "05"]) {
        writeFileSync(join(bdir, `tasks-2026-01-${d}.json`), JSON.stringify([{ id: `old-${d}`, title: `Old ${d}` }]));
      }

      // Trigger write and retention
      await api(s, "POST", "/api/tasks", { title: "New Task" });

      const taskBackups = readdirSync(bdir).filter((f) => f.startsWith("tasks-"));
      expect(taskBackups.length).toBe(3);
      expect(existsSync(join(bdir, "tasks-2026-01-05.json"))).toBe(true);
      expect(existsSync(join(bdir, "tasks-2026-01-04.json"))).toBe(true);
      expect(existsSync(join(bdir, "tasks-2026-01-01.json"))).toBe(false);
      expect(existsSync(join(bdir, "tasks-2026-01-02.json"))).toBe(false);
    } finally {
      s.stop();
    }
  });

  test("retention never deletes a file that does not match the backup name pattern", async () => {
    const s = await startServer({ env: { BUNDO_BACKUP_KEEP: "1" } });
    try {
      const bdir = join(s.dataDir, "backups");
      mkdirSync(bdir, { recursive: true });
      writeFileSync(join(bdir, "tasks-my-copy.json"), "[]");
      writeFileSync(join(bdir, "tasks-2026-01-01.json"), "[]");
      await api(s, "POST", "/api/tasks", { title: "Trigger" });
      expect(existsSync(join(bdir, "tasks-my-copy.json"))).toBe(true);
      expect(existsSync(join(bdir, "tasks-2026-01-01.json"))).toBe(false);
    } finally {
      s.stop();
    }
  });

  test("listing GET /api/backups lists backups newest first with all required fields", async () => {
    const s = await startServer();
    try {
      const bdir = join(s.dataDir, "backups");
      mkdirSync(bdir, { recursive: true });
      writeFileSync(join(bdir, "tasks-2026-01-02.json"), JSON.stringify([{ id: "1", title: "A" }]));
      writeFileSync(join(bdir, "projects-2026-01-03.json"), JSON.stringify([{ id: "p1", name: "Proj" }]));
      writeFileSync(join(bdir, "tasks-2026-01-05.json"), JSON.stringify([{ id: "2", title: "B" }, { id: "3", title: "C" }]));

      const { status, body } = await api(s, "GET", "/api/backups");
      expect(status).toBe(200);
      expect(body.backups).toBeDefined();
      expect(body.backups.length).toBe(3);
      expect(body.backups[0].name).toBe("tasks-2026-01-05.json");
      expect(body.backups[0].kind).toBe("tasks");
      expect(body.backups[0].date).toBe("2026-01-05");
      expect(body.backups[0].entries).toBe(2);
      expect(body.backups[0].size).toBeGreaterThan(0);
      expect(body.backups[1].name).toBe("projects-2026-01-03.json");
      expect(body.backups[1].kind).toBe("projects");
      expect(body.backups[2].name).toBe("tasks-2026-01-02.json");
    } finally {
      s.stop();
    }
  });

  test("restore POST /api/backups/restore restores tasks and creates before-restore backup", async () => {
    const s = await startServer({ tasks: [{ id: "curr", title: "Current Data" }] });
    try {
      const bdir = join(s.dataDir, "backups");
      mkdirSync(bdir, { recursive: true });
      writeFileSync(join(bdir, "tasks-2026-01-05.json"), JSON.stringify([{ id: "restored-1", title: "Restored Task" }]));

      const res = await api(s, "POST", "/api/backups/restore", { file: "tasks-2026-01-05.json" });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      // Tasks in memory & on disk now match backup
      const list = await api(s, "GET", "/api/tasks");
      expect(list.body.tasks.map((t: { title: string }) => t.title)).toEqual(["Restored Task"]);

      // Before-restore backup created holding "Current Data"
      const beforeRestoreFiles = readdirSync(bdir).filter((f) => f.includes("before-restore"));
      expect(beforeRestoreFiles.length).toBeGreaterThan(0);
      const beforeContent = readFileSync(join(bdir, beforeRestoreFiles[0]), "utf-8");
      expect(beforeContent).toContain("Current Data");
    } finally {
      s.stop();
    }
  });

  test("restore refuses invalid names with 400 and missing files with 404", async () => {
    const s = await startServer();
    try {
      // Path traversal or directory
      const p1 = await api(s, "POST", "/api/backups/restore", { file: "../tasks.json" });
      expect(p1.status).toBe(400);

      const p2 = await api(s, "POST", "/api/backups/restore", { file: "not-a-backup.json" });
      expect(p2.status).toBe(400);

      const p3 = await api(s, "POST", "/api/backups/restore", { file: "tasks.json" });
      expect(p3.status).toBe(400);

      // Valid pattern but missing
      const p4 = await api(s, "POST", "/api/backups/restore", { file: "tasks-1999-01-01.json" });
      expect(p4.status).toBe(404);
    } finally {
      s.stop();
    }
  });

  test("restore refuses unreadable backup with 400 and leaves data untouched", async () => {
    const s = await startServer({ tasks: [{ id: "keep-me", title: "Keep Me" }] });
    try {
      const bdir = join(s.dataDir, "backups");
      mkdirSync(bdir, { recursive: true });
      writeFileSync(join(bdir, "tasks-2026-01-05.json"), "{not valid json");

      const res = await api(s, "POST", "/api/backups/restore", { file: "tasks-2026-01-05.json" });
      expect(res.status).toBe(400);

      // No before-restore created
      const beforeFiles = readdirSync(bdir).filter((f) => f.includes("before-restore"));
      expect(beforeFiles.length).toBe(0);

      // Data unchanged
      const list = await api(s, "GET", "/api/tasks");
      expect(list.body.tasks.map((t: { title: string }) => t.title)).toContain("Keep Me");
    } finally {
      s.stop();
    }
  });

  test("unreadable data file at start with a backup renames corrupt file and loads backup", async () => {
    const d = mkdtempSync(join(tmpdir(), "bun-do-corrupt-test-"));
    try {
      const bdir = join(d, "backups");
      mkdirSync(bdir, { recursive: true });
      writeFileSync(join(bdir, "tasks-2026-01-05.json"), JSON.stringify([{ id: "rescued", title: "Rescued Task" }]));

      const s = await startServer({
        dataDir: d,
        rawTasks: "{corrupted json content",
      });
      try {
        const list = await api(s, "GET", "/api/tasks");
        expect(list.body.tasks.map((t: { title: string }) => t.title)).toEqual(["Rescued Task"]);

        // Corrupt file exists byte-identical
        const corruptFiles = readdirSync(d).filter((f) => f.startsWith("tasks.corrupt-"));
        expect(corruptFiles.length).toBe(1);
        expect(readFileSync(join(d, corruptFiles[0]), "utf-8")).toBe("{corrupted json content");
      } finally {
        s.stop();
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("unreadable data file at start without a backup renames corrupt file and starts empty", async () => {
    const d = mkdtempSync(join(tmpdir(), "bun-do-corrupt-test-"));
    try {
      const s = await startServer({
        dataDir: d,
        rawTasks: "{corrupted json no backup",
      });
      try {
        const list = await api(s, "GET", "/api/tasks");
        expect(list.body.tasks).toEqual([]);

        const corruptFiles = readdirSync(d).filter((f) => f.startsWith("tasks.corrupt-"));
        expect(corruptFiles.length).toBe(1);
        expect(readFileSync(join(d, corruptFiles[0]), "utf-8")).toBe("{corrupted json no backup");
      } finally {
        s.stop();
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
describe("calendar feed", () => {
  let calServer: TestServer;

  beforeAll(async () => {
    calServer = await startServer({
      tasks: [
        {
          id: "t-pay",
          title: "Electricity bill",
          date: "2026-11-02",
          type: "payment",
          priority: "P1",
          amount: "120.50",
          currency: "CHF",
          tags: ["home", "bills"],
        },
        {
          id: "t-rem",
          title: "Call the dentist",
          date: "2026-11-03",
          type: "reminder",
          priority: "P2",
        },
        {
          id: "t-dl",
          title: "Prüfungsanmeldung für das Wintersemester an der École polytechnique fédérale de Lausanne",
          date: "2026-11-04",
          type: "deadline",
          priority: "P0",
          notes: "Bring: ID, photo; fee 50 CHF\nRoom B; path C:\\temp",
        },
        {
          id: "t-w2",
          title: "Team sync",
          date: "2026-10-12",
          type: "task",
          priority: "P1",
          recurrence: { type: "weekly", dow: 0, interval: 2 },
        },
        {
          id: "t-m31",
          title: "Rent",
          date: "2026-01-31",
          type: "payment",
          priority: "P1",
          amount: "1800",
          currency: "CHF",
          recurrence: { type: "monthly", day: 31 },
        },
        {
          id: "t-m30",
          title: "Water meter",
          date: "2026-11-30",
          type: "task",
          priority: "P2",
          recurrence: { type: "monthly", day: 30, interval: 2 },
        },
        {
          id: "t-wd",
          title: "Standup",
          date: "2026-10-09",
          type: "reminder",
          priority: "P2",
          recurrence: { type: "weekdays" },
        },
        {
          id: "t-d3",
          title: "Water plants",
          date: "2026-10-09",
          type: "task",
          priority: "P2",
          recurrence: { type: "daily", interval: 3 },
        },
        {
          id: "t-d1",
          title: "Daily habit",
          date: "2026-10-09",
          type: "task",
          priority: "P2",
          recurrence: { type: "daily" },
        },
        {
          id: "t-y2",
          title: "Leap check",
          date: "2028-02-29",
          type: "deadline",
          priority: "P2",
          recurrence: { type: "yearly", month: 2, day: 29, interval: 2 },
        },
        {
          id: "t-y1",
          title: "Annual review",
          date: "2026-05-15",
          type: "task",
          priority: "P2",
          recurrence: { type: "yearly", month: 5, day: 15 },
        },
        {
          id: "t-done",
          title: "Done task",
          date: "2026-11-05",
          type: "task",
          priority: "P2",
          done: true,
        },
        {
          id: "t-back",
          title: "Backlog item",
          date: "2026-11-06",
          type: "task",
          priority: "P3",
        },
        {
          id: "t-p3dl",
          title: "P3 deadline",
          date: "2026-11-07",
          type: "deadline",
          priority: "P3",
        },
      ],
    });
  });

  afterAll(() => calServer?.stop());

  test("GET /calendar.ics returns text/calendar; charset=utf-8 with valid VCALENDAR structure", async () => {
    const res = await fetch(calServer.base + "/calendar.ics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/calendar;\s*charset=utf-8$/i);

    const text = await res.text();
    expect(text.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(text).toContain("VERSION:2.0\r\n");
    expect(text).toContain("PRODID:-//bun-do//EN\r\n");
    expect(text).toContain("X-WR-CALNAME:bun-do\r\n");
  });

  test("feed lines end with CRLF, no bare LF or CR, and fold at <= 75 octets without splitting UTF-8", async () => {
    const res = await fetch(calServer.base + "/calendar.ics");
    const raw = Buffer.from(await res.arrayBuffer());

    // Split on CRLF
    const lines = raw.toString("utf-8").split("\r\n");
    expect(lines[lines.length - 1]).toBe(""); // ends with CRLF

    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      expect(line.includes("\r")).toBe(false);
      expect(line.includes("\n")).toBe(false);
      const byteLen = Buffer.byteLength(line, "utf-8");
      expect(byteLen).toBeLessThanOrEqual(75);
    }
  });

  test("events have UID, DTSTAMP, DTSTART, DTEND (next day), and correct fields", async () => {
    const res = await fetch(calServer.base + "/calendar.ics");
    const text = await res.text();

    expect(text).toContain("UID:t-pay@bun-do\r\n");
    expect(text).toContain("DTSTART;VALUE=DATE:20261102\r\n");
    expect(text).toContain("DTEND;VALUE=DATE:20261103\r\n");
    expect(text).toContain("SUMMARY:Electricity bill - CHF 120.50\r\n");
    expect(text).toContain("CATEGORIES:home,bills\r\n");
    expect(text).toContain("PRIORITY:3\r\n");

    // P0 priority is 1
    expect(text).toContain("UID:t-dl@bun-do\r\n");
    expect(text).toContain("PRIORITY:1\r\n");
    // Escaped text in notes: \n, \;, \\
    expect(text).toContain("DESCRIPTION:Bring: ID\\, photo\\; fee 50 CHF\\nRoom B\\; path C:\\\\temp\r\n");

    // Reminders have VALARM, other types do not
    expect(text).toContain("UID:t-rem@bun-do\r\n");
    expect(text).toContain("BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:PT9H\r\n");
  });

  test("done tasks and backlog items are excluded; P3 non-task items are included", async () => {
    const res = await fetch(calServer.base + "/calendar.ics");
    const text = await res.text();

    expect(text).not.toContain("t-done@bun-do");
    expect(text).not.toContain("t-back@bun-do");
    expect(text).toContain("t-p3dl@bun-do"); // deadline P3 is not backlog
  });

  test("each RRULE form matches bun-do recurrence format", async () => {
    const res = await fetch(calServer.base + "/calendar.ics");
    const text = await res.text();

    // Daily with interval
    expect(text).toContain("RRULE:FREQ=DAILY;INTERVAL=3\r\n");
    // Daily default interval 1
    expect(text).toContain("RRULE:FREQ=DAILY\r\n");
    // Weekdays
    expect(text).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR\r\n");
    // Weekly with interval
    expect(text).toContain("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO\r\n");
    // Monthly clamped
    expect(text).toContain("RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1\r\n");
    expect(text).toContain("RRULE:FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=28,29,30;BYSETPOS=-1\r\n");
    // Yearly clamped and unclamped
    expect(text).toContain("RRULE:FREQ=YEARLY;INTERVAL=2;BYMONTH=2;BYMONTHDAY=28,29;BYSETPOS=-1\r\n");
    expect(text).toContain("RRULE:FREQ=YEARLY;BYMONTH=5;BYMONTHDAY=15\r\n");
  });

  test("?types= filter restricts events to specified types", async () => {
    const res = await fetch(calServer.base + "/calendar.ics?types=payment");
    const text = await res.text();

    expect(text).toContain("UID:t-pay@bun-do\r\n");
    expect(text).toContain("UID:t-m31@bun-do\r\n");
    expect(text).not.toContain("UID:t-rem@bun-do\r\n");
    expect(text).not.toContain("UID:t-dl@bun-do\r\n");
  });

  test("?tag= filter restricts events to tasks with the tag", async () => {
    const res = await fetch(calServer.base + "/calendar.ics?tag=home");
    const text = await res.text();

    expect(text).toContain("UID:t-pay@bun-do\r\n");
    expect(text).not.toContain("UID:t-rem@bun-do\r\n");
    expect(text).not.toContain("UID:t-m31@bun-do\r\n");
  });

  test("foreign Host gets 403 Forbidden", async () => {
    const res = await fetch(calServer.base + "/calendar.ics", {
      headers: { Host: "attacker.example:8000" },
    });
    expect(res.status).toBe(403);
  });
});
describe("first run and example tasks", () => {
  test("new data directory starts with empty tasks.json", async () => {
    const s = await startServer({ emptyFirstRun: true });
    try {
      const res = await api(s, "GET", "/api/tasks");
      expect(res.status).toBe(200);
      expect(res.body.tasks).toEqual([]);
      const diskContent = readFileSync(join(s.dataDir, "tasks.json"), "utf-8");
      expect(diskContent).toBe("[]");
    } finally {
      s.stop();
    }
  });

  test("POST /api/tasks/examples loads examples with dates between today and 14 days ahead and keeps anchors", async () => {
    const s = await startServer({ emptyFirstRun: true });
    try {
      const raw = JSON.parse(readFileSync(join(import.meta.dir, "../data/tasks.example.json"), "utf-8"));
      const exampleCount = (Array.isArray(raw) ? raw : raw.tasks).length;

      const res = await api(s, "POST", "/api/tasks/examples");
      expect(res.status).toBe(200);

      const listRes = await api(s, "GET", "/api/tasks");
      expect(listRes.status).toBe(200);
      interface TaskRecord {
        id: string;
        title: string;
        date: string;
        type: string;
        amount?: string;
        currency?: string;
        tags?: string[];
        recurrence?: {
          type?: string;
          dow?: number;
          day?: number;
        } | null;
      }
      const tasks = listRes.body.tasks as TaskRecord[];
      expect(tasks.length).toBe(exampleCount);

      const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const todayStr = fmt(new Date());
      const lastStr = fmt(new Date(Date.now() + 14 * 86400000));

      for (const t of tasks) {
        expect(t.date >= todayStr).toBe(true);
        expect(t.date <= lastStr).toBe(true);
      }

      // Weekly recurrence anchor follows new date
      for (const t of tasks.filter((t) => t.recurrence?.type === "weekly")) {
        const [y, m, d] = t.date.split("-").map(Number);
        const expectedDow = (new Date(y, m - 1, d).getDay() + 6) % 7;
        expect(t.recurrence?.dow).toBe(expectedDow);
      }

      // Monthly recurrence anchor follows new date
      for (const t of tasks.filter((t) => t.recurrence?.type === "monthly")) {
        const [, , d] = t.date.split("-").map(Number);
        expect(t.recurrence?.day).toBe(d);
      }

      // Preserves tags and payment properties
      const payment = tasks.find((t) => t.type === "payment");
      expect(payment).toBeDefined();
      expect(payment?.amount).toBe("45.00");
      expect(payment?.currency).toBe("CHF");

      const tagged = tasks.filter((t) => (t.tags || []).length > 0);
      expect(tagged.length).toBeGreaterThan(0);
    } finally {
      s.stop();
    }
  });

  test("POST /api/tasks/examples respects Host and Origin checks", async () => {
    const s = await startServer({ emptyFirstRun: true });
    try {
      // Foreign host
      const hostRes = await fetch(s.base + "/api/tasks/examples", {
        method: "POST",
        headers: { Host: `evil.com:${s.port}` },
      });
      expect(hostRes.status).toBe(403);

      // Foreign origin
      const originRes = await fetch(s.base + "/api/tasks/examples", {
        method: "POST",
        headers: { Origin: "http://evil.com" },
      });
      expect(originRes.status).toBe(403);
    } finally {
      s.stop();
    }
  });
});
