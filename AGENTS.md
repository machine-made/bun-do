# bun-do — Agent Guide

bun-do is a local-first todo app with a REST API, MCP server, and skill.
All data is stored in plain JSON files. Nothing leaves your machine.

## Key files

| File | Role |
|------|------|
| `server.ts` | HTTP server — API + static frontend |
| `cli.ts` | Service manager (`start/stop/restart/status/open`) |
| `mcp.ts` | MCP stdio server (`bun-do-mcp`) |
| `static/index.html` | Full frontend (Alpine.js, vendored, offline-capable) |
| `skill/SKILL.md` | Full API reference for skill-based agents |
| `data/tasks.json` | Live task data (not committed) |
| `data/projects.json` | Live project data (not committed) |
| `data/backups/` | Automatic daily and before-restore backups (not committed) |

## Dev commands

```bash
bun run dev          # hot-reload server on :8000
bun run start        # plain server on :8000
bun test             # API, CLI and MCP tests (run before every commit)
BUNDO_E2E=1 bun test test/e2e   # browser tests (bunx playwright-core install chromium once)
bun cli.ts start     # background service (writes PID + log)
bun cli.ts stop
bun cli.ts restart
bun cli.ts status
bun cli.ts backups   # list backups (works without running server)
bun cli.ts restore <file> # restore backup (via API if running, else direct)

Data directory: `BUNDO_DATA_DIR` env var (default `./data` in source, `~/.bun-do` when installed via npm).
Backup retention: `BUNDO_BACKUP_KEEP` env var (default 30; must be a whole number of at least 1).

## API — quick reference

Base URL: `http://localhost:8000`

```
GET    /api/tasks                        list all tasks (optional ?tag=)
POST   /api/tasks                        create task
PUT    /api/tasks/:id                    update task (partial)
DELETE /api/tasks/:id                    delete task
POST   /api/tasks/:id/subtasks           add subtask
PUT    /api/tasks/:id/subtasks/:sid      update subtask
DELETE /api/tasks/:id/subtasks/:sid      delete subtask
GET    /api/projects                     list projects
POST   /api/projects                     create project
PUT    /api/projects/:id                 update project
DELETE /api/projects/:id                 delete project
POST   /api/projects/:id/entries         add progress entry
DELETE /api/projects/:id/entries/:eid    delete entry
GET    /api/backups                      list backups (newest first)
POST   /api/backups/restore              restore backup ({ file })
```

## Task shape

```json
{
  "title": "required",
  "date": "YYYY-MM-DD",
  "priority": "P0 | P1 | P2 | P3",
  "type": "task | deadline | reminder | payment",
  "done": false,
  "notes": "",
  "recurrence": null,
  "tags": ["travel", "home"]
}
```

Priority: P0 = critical, P1 = high, P2 = normal, P3 = backlog.
Backlog: `type=task` + `priority=P3` (shows in backlog panel, not calendar).
Recurrence: `null` or `{"type": "daily"|"weekdays"|"weekly"|"monthly"|"yearly", "interval": 1-99, "dow": 0-6, "day": 1-31, "month": 1-12}`. `interval` applies to daily, weekly, monthly and yearly (weekdays only accepts 1) and is stored only above 1. `dow` is the weekly anchor (0 = Monday), `day` the monthly one, `month` + `day` the yearly one; a missing anchor is taken from the task's date. An invalid rule is a 400.
Tags: a list, or one comma-separated string on create and update. Normalised on write: trimmed, a leading `#` removed, lower case, whitespace runs become `-`, only letters, digits, `-` and `_`, at most 32 characters, at most 10 per task, duplicates dropped. Missing tags on old files load as `[]`. `GET /api/tasks?tag=work` (also `#work`) returns only tasks carrying that tag; omit `tag` for the full list. The next occurrence of a recurring task keeps its tags.

## Backups & data safety

Before the first write of each local calendar day to `tasks.json` (and, separately, to `projects.json`), the server copies the current file to `BUNDO_DATA_DIR/backups/` as `tasks-YYYY-MM-DD.json` (`projects-YYYY-MM-DD.json`). Later writes that day leave it alone. The newest `BUNDO_BACKUP_KEEP` backups of each kind are retained (default 30).

`POST /api/backups/restore` with `{"file": "<name>"}` accepts only a bare name of the backup pattern. It first saves the current file as `<kind>-YYYY-MM-DDTHHMMSS-before-restore.json`, then loads the backup into memory and onto disk.

At startup, an unreadable or invalidly shaped `tasks.json` or `projects.json` is renamed to `<kind>.corrupt-<YYYYMMDD-HHMMSS>.json` (byte-identical, never overwritten), the path is logged, and the newest readable backup of that kind is loaded (or an empty list if none).

## Common agent operations

**Check server is up:**
```bash
curl -sf http://localhost:8000/api/tasks > /dev/null && echo OK || echo "run: bun-do start"
```

**Add a task:**
```bash
curl -s -X POST http://localhost:8000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title": "My task", "priority": "P1"}'
```

**Find task ID by title:**
```bash
curl -s http://localhost:8000/api/tasks | python3 -c "
import sys,json
for t in json.load(sys.stdin)['tasks']:
    if 'TERM' in t['title'].lower(): print(t['id'], t['title'])
"
```

**Mark done / edit / delete:**
```bash
curl -s -X PUT  http://localhost:8000/api/tasks/ID -H 'Content-Type: application/json' -d '{"done":true}'
curl -s -X PUT  http://localhost:8000/api/tasks/ID -H 'Content-Type: application/json' -d '{"priority":"P0"}'
curl -s -X DELETE http://localhost:8000/api/tasks/ID
```

**Log project progress:**
```bash
# find project id
curl -s http://localhost:8000/api/projects | python3 -c "
import sys,json
for p in json.load(sys.stdin)['projects']: print(p['id'], p['name'])
"
# add entry
curl -s -X POST http://localhost:8000/api/projects/PROJECT_ID/entries \
  -H 'Content-Type: application/json' \
  -d '{"summary": "What was done"}'
```

**List and restore backups:**
```bash
# list backups
curl -s http://localhost:8000/api/backups

# restore a backup (saves current state as before-restore first)
curl -s -X POST http://localhost:8000/api/backups/restore \
  -H 'Content-Type: application/json' \
  -d '{"file": "tasks-2026-01-05.json"}'
```

## Agent rules

- Always verify the server is running before any API call.
- Never guess IDs — always look them up by title first.
- Dates are `YYYY-MM-DD`. Omit for today.
- Only send fields you want to change on PUT requests.
- Full curl examples: `skill/SKILL.md`
- MCP tools: `bun-do-mcp` — `list_tasks` (optional `tag`), `add_task` and `update_task` (`tags`, `recurrence`, `amount`, `currency`), `delete_task`, `list_projects`, `add_project_entry`. A failed tool call returns `isError: true` on the result, not a JSON-RPC error.
