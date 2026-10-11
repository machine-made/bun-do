// Browser tests for the web interface. They run only with BUNDO_E2E=1, so plain `bun test`
// needs no browser. Install the browser once with `bunx playwright-core install chromium`,
// or point BUNDO_CHROME at an installed Chrome.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { Browser, Page } from "playwright-core";
import { api, localDate, startServer, type TestServer } from "../helpers";

const enabled = process.env.BUNDO_E2E === "1";
const today = localDate(Intl.DateTimeFormat().resolvedOptions().timeZone);

let server: TestServer;
let browser: Browser;

/** Open the app in a new page and collect console errors and uncaught exceptions. */
async function openApp(theme: "dark" | "light" = "dark"): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
  await page.goto(server.base + "/");
  await page.waitForFunction(() => (window as any).Alpine !== undefined);
  await page.waitForTimeout(300);
  return { page, errors };
}

describe.skipIf(!enabled)("web interface", () => {
  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    server = await startServer({
      tasks: [
        { id: "pay-1", title: "Electricity bill", date: today, type: "payment", amount: "120.50", currency: "CHF" },
      ],
    });
    browser = await chromium.launch({ executablePath: process.env.BUNDO_CHROME || undefined });
  });

  afterAll(async () => {
    await browser?.close();
    server?.stop();
  });

  for (const theme of ["dark", "light"] as const) {
    test(`loads without console errors (${theme} theme)`, async () => {
      const { page, errors } = await openApp(theme);
      expect(errors).toEqual([]);
      await page.close();
    });
  }

  test("payment amounts show with their currency", async () => {
    const { page } = await openApp();
    const amount = page.locator(".payment-amount", { hasText: "CHF 120.50" }).first();
    await amount.waitFor({ state: "visible", timeout: 3000 });
    await page.close();
  });

  test("a task added through the form is saved and shown", async () => {
    const { page, errors } = await openApp();
    await page.keyboard.press("n");
    await page.getByPlaceholder("Task title").fill("Water the plants");
    await page.getByRole("dialog").first().getByRole("button", { name: "Add task" }).click();
    await page.getByText("Water the plants").first().waitFor({ timeout: 3000 });
    const { body } = await api(server, "GET", "/api/tasks");
    expect(body.tasks.map((t: { title: string }) => t.title)).toContain("Water the plants");
    expect(errors).toEqual([]);
    await page.close();
  });

  test("ticking the checkbox marks the task done", async () => {
    const { body: task } = await api(server, "POST", "/api/tasks", { title: "Tick me", date: today });
    const { page, errors } = await openApp();
    await page.locator(`[data-task-id="${task.id}"] .checkbox-wrap`).first().click();
    await page.waitForTimeout(300);
    const { body } = await api(server, "GET", "/api/tasks");
    expect(body.tasks.find((t: { id: string }) => t.id === task.id).done).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  });

  test("keys 1 to 5 switch views and / focuses search", async () => {
    const { page, errors } = await openApp();
    for (const key of ["1", "2", "3", "4", "5"]) {
      await page.keyboard.press(key);
      await page.waitForTimeout(100);
    }
    await page.keyboard.press("/");
    const focused = await page.evaluate(() => document.activeElement?.classList.contains("search-input"));
    expect(focused).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  });

  test("quick-add #tag shows a chip, and the tag filter hides untagged tasks until cleared", async () => {
    await api(server, "POST", "/api/tasks", { title: "Untagged errand", date: today });
    const { page, errors } = await openApp();
    try {
      await page.evaluate(() => localStorage.removeItem("tagFilter"));
      await page.keyboard.press("n");
      await page.getByPlaceholder("Task title").fill("Buy oats #Groceries");
      await page.getByRole("button", { name: "Add task" }).click();
      const row = page.locator(".task-row", { hasText: "Buy oats" }).first();
      await row.waitFor({ timeout: 3000 });
      await row.locator(".tag-chip", { hasText: "#groceries" }).waitFor();
      expect(await row.locator(".task-title").innerText()).toBe("Buy oats");

      const untagged = page.locator(".task-row", { hasText: "Untagged errand" });
      await untagged.first().waitFor({ state: "visible", timeout: 3000 });

      await page.locator(".search-input").fill("groceries");
      await page.waitForFunction(() => ![...document.querySelectorAll(".task-row")].some((el) => el.textContent?.includes("Untagged errand")));
      expect(await untagged.count()).toBe(0);
      await row.waitFor({ state: "visible" });
      await page.locator(".search-input").fill("");
      await untagged.first().waitFor({ state: "visible", timeout: 3000 });

      await page.locator(".tag-filter[data-tag='groceries']").click();
      await page.waitForFunction(() => ![...document.querySelectorAll(".task-row")].some((el) => el.textContent?.includes("Untagged errand")));
      expect(await untagged.count()).toBe(0);
      await row.waitFor({ state: "visible" });
      expect(await page.evaluate(() => localStorage.getItem("tagFilter"))).toBe("groceries");

      await page.reload();
      await page.waitForFunction(() => "Alpine" in window);
      await page.locator(".task-row", { hasText: "Buy oats" }).first().waitFor({ timeout: 3000 });
      expect(await page.locator(".task-row", { hasText: "Untagged errand" }).count()).toBe(0);

      await page.getByRole("button", { name: "Clear tag filter" }).click();
      await page.locator(".task-row", { hasText: "Untagged errand" }).first().waitFor({ timeout: 3000 });
      expect(await page.evaluate(() => localStorage.getItem("tagFilter"))).toBeNull();
      expect(errors).toEqual([]);
    } finally {
      await page.evaluate(() => localStorage.removeItem("tagFilter")).catch(() => {});
      await page.close();
    }
  });

  test("the tags field and in-place edit replace the list", async () => {
    const { page, errors } = await openApp();
    try {
      await page.keyboard.press("n");
      await page.getByPlaceholder("Task title").fill("Label me");
      await page.locator("#task-tags").fill("Home, Work");
      await page.getByRole("button", { name: "Add task" }).click();
      const row = page.locator(".task-row", { hasText: "Label me" }).first();
      await row.locator(".tag-chip", { hasText: "#home" }).waitFor({ timeout: 3000 });
      await row.locator(".tag-chip", { hasText: "#work" }).waitFor();
      await row.hover();
      await row.getByRole("button", { name: "Edit tags" }).click();
      const input = row.locator(".task-tags-edit");
      await input.fill("errands");
      await input.press("Enter");
      await row.locator(".tag-chip", { hasText: "#errands" }).waitFor({ timeout: 3000 });
      expect(await row.locator(".tag-chip", { hasText: "#home" }).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("an every-2-weeks task created through the form shows its label", async () => {
    const { page, errors } = await openApp();
    const dayName = new Date(`${today}T12:00:00`).toLocaleDateString("en-US", { weekday: "long" });
    try {
      await page.keyboard.press("n");
      await page.getByPlaceholder("Task title").fill("Biweekly meeting");
      await page.locator("select.form-select").selectOption("weekly");
      await page.locator(".recurrence-interval input").fill("2");
      await page.getByRole("button", { name: "Add task" }).click();

      const { body } = await api(server, "GET", "/api/tasks");
      const created = body.tasks.find((t: { title: string }) => t.title === "Biweekly meeting");
      expect(created.recurrence).toEqual({ type: "weekly", dow: (new Date(`${today}T12:00:00`).getDay() + 6) % 7, interval: 2 });

      const row = page.locator(".task-row", { hasText: "Biweekly meeting" }).first();
      await row.waitFor({ timeout: 3000 });
      const icon = row.locator(".recurrence-icon");
      await icon.waitFor({ state: "visible", timeout: 3000 });
      expect(await icon.getAttribute("title")).toBe(`Every 2 weeks on ${dayName}`);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("backups dialog opens from header, lists backups, and restores after confirmation", async () => {
    const bdir = join(server.dataDir, "backups");
    mkdirSync(bdir, { recursive: true });
    writeFileSync(
      join(bdir, "tasks-2026-01-05.json"),
      JSON.stringify([{ id: "backup-task-1", title: "Restored From E2E Backup", date: today, priority: "P1", type: "task", done: false, subtasks: [], tags: [] }]),
    );

    const { page, errors } = await openApp();
    try {
      page.on("dialog", (dialog) => dialog.accept());

      await page.getByRole("button", { name: "Backups" }).click();

      const modal = page.locator(".modal", { hasText: "Backups" });
      await modal.waitFor({ state: "visible", timeout: 3000 });
      expect(await modal.textContent()).toContain("tasks-2026-01-05.json");
      await modal.locator("div").filter({ hasText: "tasks-2026-01-05.json" }).getByRole("button", { name: "Restore" }).last().click();
      const toast = page.locator(".toast.visible");
      await toast.waitFor({ timeout: 5000 });
      expect(await toast.textContent()).toContain("Restored tasks-2026-01-05.json");

      const restoredRow = page.getByText("Restored From E2E Backup").first();
      await restoredRow.waitFor({ state: "visible", timeout: 3000 });

      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  test("calendar entry in header opens subscription dialog with webcal url, copy button, and download link", async () => {
    const { page, errors } = await openApp();
    try {
      await page.getByRole("button", { name: "Calendar", exact: true }).click();
      const modal = page.locator(".modal", { hasText: "Calendar" });
      await modal.waitFor({ state: "visible", timeout: 3000 });

      const input = modal.locator("input.form-input");
      const val = await input.inputValue();
      expect(val).toBe(`webcal://localhost:${server.port}/calendar.ics`);

      const copyBtn = modal.getByRole("button", { name: "Copy" });
      expect(await copyBtn.isVisible()).toBe(true);

      const downloadLink = modal.getByRole("link", { name: "Download .ics" });
      expect(await downloadLink.isVisible()).toBe(true);
      expect(await downloadLink.getAttribute("href")).toBe("/calendar.ics");

      expect(await modal.textContent()).toContain(
        "Google Calendar cannot reach a local server, so Google users import the file."
      );

      await modal.getByRole("button", { name: "Close", exact: true }).click();
      await modal.waitFor({ state: "hidden", timeout: 3000 });

      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  test("empty first run displays guide with Add task and Load example buttons, and loading examples hides guide", async () => {
    const emptyServer = await startServer({ emptyFirstRun: true });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));

    try {
      await page.goto(emptyServer.base + "/");
      await page.waitForFunction(() => (window as unknown as { Alpine?: unknown }).Alpine !== undefined);

      const guide = page.locator(".guide-panel");
      await guide.waitFor({ state: "visible", timeout: 3000 });

      expect(await guide.textContent()).toContain("How to add a task");
      expect(await guide.textContent()).toContain("Keyboard shortcuts");
      expect(await guide.textContent()).toContain("Where data is stored");

      const addBtn = page.getByRole("button", { name: "Add task" });
      expect(await addBtn.isVisible()).toBe(true);

      const loadBtn = page.getByRole("button", { name: "Load example tasks" });
      expect(await loadBtn.isVisible()).toBe(true);

      await loadBtn.click();
      await guide.waitFor({ state: "hidden", timeout: 3000 });
      await page.keyboard.press("1");
      await page.getByText("Write unit tests for API").first().waitFor({ timeout: 3000 });
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      emptyServer.stop();
    }
  });
  // ── Accessibility ─────────────────────────────────────────────────────────

  test("axe finds no serious or critical violations on any view in both themes", { timeout: 30_000 }, async () => {
    const { body: t1 } = await api(server, "POST", "/api/tasks", { title: "Axe test task", date: today, priority: "P1" });
    await api(server, "POST", `/api/tasks/${t1.id}/subtasks`, { title: "Sub item" });
    const axe = await Bun.file("node_modules/axe-core/axe.min.js").text();

    for (const theme of ["dark", "light"] as const) {
      for (const [w, h] of [[1280, 800], [360, 740]] as const) {
        const page = await browser.newPage({ viewport: { width: w, height: h } });
        const errors: string[] = [];
        page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
        await page.goto(server.base + "/");
        await page.waitForFunction(() => (window as { Alpine?: unknown }).Alpine !== undefined);
        await page.waitForTimeout(200);
        expect(await page.evaluate(() => document.documentElement.classList.contains("light"))).toBe(theme === "light");

        const scan = async (name: string) => {
          await page.addScriptTag({ content: axe });
          const res = await page.evaluate(async () => {
            const axeFn = window.axe;
            if (!axeFn) throw new Error("axe-core did not load");
            return axeFn.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
          });
          for (const v of res.violations) {
            if (v.impact === "serious" || v.impact === "critical") {
              errors.push(`${theme}/${w}px/${name}: ${v.id} (${v.impact}) on ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target?.join(" ")}: ${v.nodes[0]?.failureSummary}`);
            }
          }
        };

        for (let i = 0; i < 7; i++) {
          const tab = page.locator(".view-tab").nth(i);
          const name = (await tab.innerText()).trim() || `tab-${i}`;
          await tab.click();
          await page.waitForTimeout(150);
          await scan(name);
          if (errors.length) break;
        }
        if (!errors.length) {
          await page.locator(".view-tab", { hasText: "All" }).click();
          await page.locator(".task-row", { hasText: "Axe test task" }).first().waitFor({ timeout: 3000 });
          await page.locator(`[data-task-id="${t1.id}"] .subtask-toggle`).first().click();
          await page.locator(".subtask-row", { hasText: "Sub item" }).first().waitFor({ timeout: 3000 });
          await scan("open subtasks");
        }
        if (!errors.length) {
          await page.keyboard.press("n");
          await page.locator("#task-title").waitFor({ state: "visible", timeout: 3000 });
          await page.waitForTimeout(250);
          await scan("add dialog");
        }
        expect(errors).toEqual([]);
        await page.close();
      }
    }
  });

  test("keyboard opens and closes the add dialog", async () => {
    const { page, errors } = await openApp();
    await page.getByRole("button", { name: "+ Add" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    const dialog = page.locator(".modal-backdrop >> .modal:visible").first();
    await dialog.waitFor({ state: "visible", timeout: 3000 });
    expect(await dialog.getAttribute("aria-modal")).toBe("true");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("task-title");
    // Page shortcuts do nothing behind the open dialog.
    await page.locator(".type-chip", { hasText: "Deadline" }).focus();
    await page.keyboard.press("1");
    expect(await page.locator(".view-tab.active").innerText()).toBe("Month");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    expect(await page.locator(".modal-backdrop >> .modal:visible").first().isVisible()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("+ Add");
    expect(errors).toEqual([]);
    await page.close();
  });

  test("Enter after editing a title saves it and gives focus back to the title", async () => {
    const { body: task } = await api(server, "POST", "/api/tasks", { title: "Rename me", date: today });
    const { page, errors } = await openApp();
    try {
      const title = page.locator(`[data-task-id="${task.id}"] .task-title`).first();
      await title.click();
      const input = page.locator(`[data-task-id="${task.id}"] .task-title-edit`).first();
      await input.fill("Renamed");
      await input.press("Enter");
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => document.activeElement?.classList.contains("task-title"))).toBe(true);
      expect(await title.innerText()).toBe("Renamed");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("the month grid puts day 1 under its weekday", async () => {
    const { page, errors } = await openApp();
    try {
      await page.keyboard.press("2");
      await page.locator(".cal-week").first().waitFor({ timeout: 3000 });
      const label = await page.locator(".period-label").innerText();
      const [monthName, year] = label.split(" ");
      const month = new Date(`${monthName} 1, 2000`).getMonth();
      const expected = (new Date(Number(year), month, 1).getDay() + 6) % 7;
      const blanks = await page.evaluate(() => {
        const week = document.querySelector(".cal-week");
        const cells = [...(week?.querySelectorAll(".cal-cell") ?? [])];
        return { before: cells.findIndex((c) => !c.classList.contains("empty")), total: cells.length };
      });
      expect(blanks.total).toBe(7);
      expect(blanks.before).toBe(expected);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
