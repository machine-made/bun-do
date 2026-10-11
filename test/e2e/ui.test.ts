// Browser tests for the web interface. They run only with BUNDO_E2E=1, so plain `bun test`
// needs no browser. Install the browser once with `bunx playwright-core install chromium`,
// or point BUNDO_CHROME at an installed Chrome.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
    await page.getByRole("button", { name: "Add task" }).click();
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
});
