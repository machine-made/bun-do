# Changelog

## [Unreleased]

### Changed
- **New npm name: `@machine-made/bun-do`.** Install with `bun install -g @machine-made/bun-do`. The old `bun-do` package stops at 1.5.1 and is marked deprecated. The commands (`bun-do`, `bun-do-mcp`) do not change.

## [v1.5.1] — 2026-10-28

This is the first npm release since v1.4.0. It carries the changes of v1.4.1, v1.4.2 and v1.5.0, which were tagged but never reached npm. The headlines:
- **Security:** the server listens on 127.0.0.1 only, refuses foreign Host headers, and refuses writes from foreign origins.
- **Data safety:** an unreadable `tasks.json` is kept and the newest backup is loaded; daily backups with restore; npm releases use trusted publishing.
- **New:** tags, more repeat rules, a calendar feed at `/calendar.ics`, a first-run guide, and a keyboard-, screen-reader- and phone-friendly page.

See the v1.5.0, v1.4.2 and v1.4.1 entries below for the full lists.

### Changed
- The repository, homepage and docs links now point to github.com/machine-made/bun-do.

---

## [v1.5.0] — 2026-10-11

v1.4.1 and v1.4.2 were tagged but never reached npm; this release carries their changes too.

### Added
- **Tags.** Each task carries up to 10 tags (lower case, letters, digits, `-` and `_`). Type `#word` in a new task's title, use the Tags field, or edit tags in place. One tag filter works in every view, search matches tags, and `GET /api/tasks?tag=` filters through the API.
- **More repeat rules:** daily, weekdays (Monday to Friday), and every N days, weeks, months or years (N up to 99). Monthly and yearly rules keep their day and land on the last day of short months.
- **Daily backups.** Before the first change of each day, `tasks.json` and `projects.json` are copied to `backups/`; the newest 30 of each are kept (`BUNDO_BACKUP_KEEP`). Restore one from the Backups dialog, with `bun-do restore <file>`, or through `POST /api/backups/restore`; the current state is saved first. `bun-do backups` lists them.
- **Calendar feed** at `/calendar.ics`: open tasks as all-day events, repeat rules as RRULE, a 09:00 alarm for reminders. Apple Calendar, Outlook or Thunderbird on the same computer can subscribe to `webcal://localhost:<port>/calendar.ics`; Google Calendar cannot reach a local server, so download the file and import it there.
- **First-run guide** with a "Load example tasks" button; the examples land in the next two weeks.
- `bun-do help` (`--help`, `-h`).
- MCP: `add_task` and `update_task` take `tags`, `recurrence`, `amount` and `currency`; `list_tasks` takes `tag`.
- Browser tests (playwright-core) and accessibility checks (axe-core) in CI.
- `bun run screenshots` takes the README screenshots from the example tasks.

### Changed
- **The page works by keyboard, with a screen reader, and on a phone.** Every control is a button with a name that says which task it acts on; checkboxes report their state; dialogs are named, take focus on their first field, give it back when they close, and make the page behind them inactive. Text meets WCAG AA contrast in both themes and the focus ring is always visible; reduced-motion settings turn transitions off. At 600 px and narrower the header is two rows that scroll sideways, controls are at least 44 px, task buttons move under the title, dialogs fill the screen, and the page no longer scrolls sideways (it was 469 px wide at 360 px). The light theme's orange is darker to meet contrast.
- Every view shows an empty state with an action, also when search or the tag filter hides everything.
- The README is rewritten around the features, with new screenshots.
- A new install starts with no tasks instead of the example tasks.
- An unknown command now prints an error and the help and exits 1; before, it started the server. `bun-do status` exits 1 when the server is not running and prints the version, address, data directory and log path. A `start` that cannot reach the server prints the last log lines and exits 1.
- An invalid repeat rule sent to the API is refused with HTTP 400 and a message naming the field; before, it was dropped silently.
- A failed MCP tool call is reported as a tool result with `isError: true` instead of a JSON-RPC error.

### Fixed
- **An unreadable `tasks.json` lost every task.** The server replaced it with an empty list on the next save. It is now kept as `tasks.corrupt-<time>.json`, unchanged, and the newest backup is loaded instead.
- A monthly rule on the 31st drifted to the 28th after February when it was created without its day. Rules now take their anchor from the task's date.

---

## [v1.4.2] — 2026-10-11

v1.4.1 was tagged but never reached npm; this release carries its changes too.

### Security
- **Foreign Host headers are refused.** The server answered any Host header, so a web page that points its own domain at 127.0.0.1 (DNS rebinding) could read every task and payment. It now answers only `localhost` and `127.0.0.1`.
- **Writes must come from the app's own origin.** A write that carries an `Origin` header is refused unless the origin is this server. Before, any origin on `localhost`, on any port, could change tasks. Requests without `Origin` (curl, the MCP server, scripts) still work.

### Fixed
- **The native macOS app could not save changes.** It loads the page from `127.0.0.1`, and the write check accepted only `localhost`. Saving from `http://127.0.0.1:<port>` now works.
- **New tasks near midnight got the wrong date.** "Today" was the UTC date while every other date was local, so new tasks and carried-over tasks could land on yesterday or tomorrow. "Today" is now the local date.
- **Payment amounts stayed blank** in the Day and Payments lists. They now show with their currency symbol.
- The page threw a console error on load while no calendar day was selected. It no longer does.
- The MCP server now calls `127.0.0.1` instead of `localhost`, which can resolve to `::1`, where the server does not listen.

### Added
- Test suite (`bun test`): API, CLI and MCP server, each against a real server with a temporary data directory.
- CI: the tests run on Ubuntu and macOS for every push and pull request.

### Changed
- Vendored Alpine.js 3.15.8 → 3.17.4.
- npm releases use trusted publishing: no npm token is stored anywhere, and npm attaches provenance to each release. The publish job runs the tests and refuses a tag that does not match the `package.json` version.

---

## [v1.4.1] — 2026-10-09

### Security
- **Server listens on 127.0.0.1 only.** Before, Bun's default bound every network interface, so anyone on the same network could read and change tasks through the API, which has no login.

### Added
- `static/THIRD_PARTY_LICENSES.txt` with the MIT licenses of the vendored Alpine.js 3.15.8 and SortableJS 1.15.7.
- README: a Disclaimer section (no warranty; use and misuse at the user's own risk).

---

## [v1.4.0] — 2026-02-18

### Added
- **Native macOS app** — `bun-do app` opens a lightweight WKWebView window (no Electron). Compiles Swift source on first run and caches the binary in `~/.bun-do/app/`.
- Screenshot in README

### Changed
- **SKILL.md rewrite** — natural language mapping table, proactive patterns (morning briefing, weekly review), payment tracking examples
- npm package only ships `bin/bun-do-webview.swift` instead of entire `bin/` directory

### Fixed
- **First-run empty tasks** — `tasks.example.json` wraps tasks in `{ "tasks": [...] }` but `parseTasks` expected a bare array, causing blank task list on first boot
- Recurrence validation bypass — `parseTasks` now routes through `sanitizeRecurrence()` instead of raw cast
- `child.pid` undefined guard when spawning background server
- Removed stale `macapp` script referencing deleted `bin/bun-do.app`

---

## [v1.3.0] — 2026-02-18

### Added
- **MCP server** (`bun-do-mcp`) — stdio JSON-RPC 2.0 server exposing 6 tools: `list_tasks`, `add_task`, `update_task`, `delete_task`, `list_projects`, `add_project_entry`. Works with Claude Desktop, opencode, and any MCP client.
- **Installable skill** — Markdown skill for Claude Code and OpenClaw (`bun-do install-skill` / `bun-do install-skill --openclaw`)
- **OpenClaw integration** — bun-do positioned as the task layer for [OpenClaw](https://github.com/openclaw/openclaw); route tasks from WhatsApp, Telegram, Slack via your local AI assistant
- `AGENTS.md` — machine-readable orientation guide for AI agents

### Fixed
- CLI: replaced HTTP `fetch()` health check in `waitForReady()` with TCP socket connect — removes unnecessary network access during startup
- MCP: guard `params` destructuring against malformed `tools/call` requests
- MCP: added `ping` handler required by MCP spec

---

## [v1.2.1] — 2026-02-17

### Added
- Vendored **Alpine.js 3.15.8** and **SortableJS 1.15.7** — no CDN dependency, fully offline-capable
- `.gitattributes` marks vendored minified files as binary/linguist-generated

### Changed
- Removed Google Fonts CDN link

### Fixed
- CLI: `--serve` flag fallthrough into service manager switch

---

## [v1.2.0] — 2026-02-16

### Changed
- Server refactor: in-memory store with atomic JSON writes — eliminates read/write races
- Union types for task and project shapes — stricter TypeScript throughout
- `findById` helpers — cleaner route handlers

---

## [v1.1.3] — 2026-02-15

### Added
- GitHub Actions workflow to publish to npm on version tag push (`NPM_TOKEN` secret)

---

## [v1.1.2] — 2026-02-14

### Added
- `bun-do --version` flag
- Version printed on server start and restart

---

## [v1.1.1] — 2026-02-13

### Added
- **CLI service manager** (`cli.ts`): `start`, `stop`, `restart`, `status`, `open` commands
- Background server with PID file tracking and log output
- `bun-do open` starts the server and opens the browser automatically

---

## [v1.1.0] — 2026-02-12

Initial public release.

### Features
- Year / month / day agenda calendar views with auto-sync to current date
- Task rollover: overdue tasks carry to today automatically (payments keep original date)
- Priorities P0–P3 (critical → backlog) with optional Eisenhower matrix labels
- Task types: task, deadline, reminder, payment
- Recurring tasks: weekly, monthly, yearly with auto-creation on completion
- Subtasks with drag-and-drop reorder
- Projects tracker with timestamped progress log entries
- Payments view grouped by month with per-month subtotals
- Live search across titles and notes
- Keyboard shortcuts: `n` new task, `1`–`5` views, `/` search, `Esc` dismiss
- Light / dark theme, adjustable font size
- Undo delete with 10-second recovery window
- REST API via `Bun.serve()` — zero runtime dependencies
- Alpine.js + SortableJS frontend, no build step, works offline
