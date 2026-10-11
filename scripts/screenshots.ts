// Take the README screenshots: the example tasks in a temporary data directory, shown in
// headless Chromium on desktop (dark and light) and on a phone.
//
//   bun run screenshots
//
// Needs the browser once: `bunx playwright-core install chromium`, or set BUNDO_CHROME to an
// installed Chrome. Your own tasks are never read or changed.

import { mkdirSync } from "fs";
import { join } from "path";
import { chromium } from "playwright-core";
import { api, ROOT, startServer } from "../test/helpers";

const shots = [
  { file: "bun-do.png", theme: "dark", view: "Month", width: 1280, height: 860 },
  { file: "screenshots/desktop-light.png", theme: "light", view: "All", width: 1280, height: 860 },
  { file: "screenshots/phone.png", theme: "dark", view: "All", width: 390, height: 844 },
] as const;

const server = await startServer();
const browser = await chromium.launch({ executablePath: process.env.BUNDO_CHROME || undefined });
try {
  const { status } = await api(server, "POST", "/api/tasks/examples");
  if (status !== 200) throw new Error(`loading the example tasks failed with HTTP ${status}`);
  mkdirSync(join(ROOT, "screenshots"), { recursive: true });

  for (const shot of shots) {
    const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height }, deviceScaleFactor: 2 });
    await page.addInitScript((theme) => localStorage.setItem("theme", theme), shot.theme);
    await page.goto(server.base + "/");
    await page.waitForFunction(() => "Alpine" in window);
    await page.locator(".view-tab", { hasText: shot.view }).first().click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(ROOT, shot.file) });
    await page.close();
    console.log(`wrote ${shot.file}`);
  }
} finally {
  await browser.close();
  server.stop();
}
