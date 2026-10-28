---
name: bun-do-api
description: >
  Manage bun-do tasks and projects — add tasks, edit tasks, delete tasks,
  toggle done, manage subtasks, and log project progress entries. Use when the
  user says "add a todo", "update task", "remove task", "mark done", "add
  subtask", "log progress", "update project", or any variant of managing
  tasks/projects. Also use when an agent finishes work and needs to record
  progress. Triggers on: "todo", "task", "remind me", "due", "deadline",
  "payment", "bill", "backlog", "what do I need to do", "what's overdue",
  "add to my list".
---

# bun-do — your local task backend

> "Add P1 task: renew passport, due March 30, recurring yearly, with €85 payment"

bun-do is a local-first todo app. REST API at `http://localhost:8000`. All data persists to JSON on disk. Nothing leaves your machine.

**Start**: `bun-do start` (install: `bun install -g @machine-made/bun-do`)
**Data**: `~/.bun-do/` (override: `BUNDO_DATA_DIR`)
**Port**: 8000 (override: `--port=PORT`)

## How users talk (map these to API calls)

| User says | Action |
|-----------|--------|
| "add task: buy milk" | POST `/api/tasks` `{"title": "Buy milk"}` |
| "remind me to call dentist tomorrow" | POST with `{"title": "Call dentist", "date": "TOMORROW", "type": "reminder"}` |
| "P0 deadline: submit proposal by Friday" | POST with `{"title": "Submit proposal", "date": "FRIDAY", "priority": "P0", "type": "deadline"}` |
| "add monthly payment: rent €1200 on the 1st" | POST with `{"title": "Rent", "type": "payment", "amount": "1200", "currency": "EUR", "recurrence": {"type": "monthly", "day": 1}}` |
| "what's overdue?" | GET `/api/tasks`, filter `done=false` where `date < today` |
| "mark passport task done" | Search by title → PUT `{"done": true}` |
| "what should I do today?" | GET `/api/tasks`, filter for today's date, sort by priority |
| "move it to next week" | PUT with `{"date": "NEXT_MONDAY"}` |
| "add subtask: book flight" | POST `/api/tasks/{id}/subtasks` `{"title": "Book flight"}` |
| "log progress on bun-do: shipped v1.3" | POST `/api/projects/{id}/entries` `{"summary": "Shipped v1.3"}` |

**Important**: Always resolve relative dates ("tomorrow", "next Friday") to `YYYY-MM-DD` before sending.

## API reference

| Action | Method | Endpoint |
|--------|--------|----------|
| List tasks | GET | `/api/tasks` (optional `?tag=`) |
| Add task | POST | `/api/tasks` |
| Edit task | PUT | `/api/tasks/{id}` |
| Delete task | DELETE | `/api/tasks/{id}` |
| Add subtask | POST | `/api/tasks/{id}/subtasks` |
| Edit subtask | PUT | `/api/tasks/{id}/subtasks/{sid}` |
| Delete subtask | DELETE | `/api/tasks/{id}/subtasks/{sid}` |
| Reorder backlog | POST | `/api/tasks/reorder` |
| Clear done | POST | `/api/tasks/clear-done` |
| List projects | GET | `/api/projects` |
| Add project | POST | `/api/projects` |
| Edit project | PUT | `/api/projects/{id}` |
| Delete project | DELETE | `/api/projects/{id}` |
| Add log entry | POST | `/api/projects/{id}/entries` |
| Delete log entry | DELETE | `/api/projects/{id}/entries/{eid}` |
| List backups | GET | `/api/backups` |
| Restore backup | POST | `/api/backups/restore` |
| Calendar feed | GET | `/calendar.ics` (optional `?types=`, `?tag=`) |
## Task fields

```json
{
  "title": "string (required)",
  "date": "YYYY-MM-DD (default: today)",
  "priority": "P0 | P1 | P2 | P3 (default: P2)",
  "type": "task | deadline | reminder | payment (default: task)",
  "notes": "string",
  "done": false,
  "amount": "string (for payments)",
  "currency": "CHF | USD | EUR | BRL (default: CHF)",
  "recurrence": null | {"type": "daily", "interval": 1-99} | {"type": "weekdays"} | {"type": "weekly", "dow": 0-6, "interval": 1-99} | {"type": "monthly", "day": 1-31, "interval": 1-99} | {"type": "yearly", "month": 1-12, "day": 1-31, "interval": 1-99},
  "tags": ["travel", "home"]
}
```

**Priorities**: P0 = critical/drop everything, P1 = high/do today, P2 = normal, P3 = backlog (not on calendar).
**Types**: `task` = actionable, `deadline` = hard date, `reminder` = FYI, `payment` = bill/invoice tracker.
**Recurring**: When a recurring task is marked done, the next occurrence is auto-created. Types: `daily` (every N days), `weekdays` (Monday to Friday), `weekly` (on `dow`, 0 = Monday), `monthly` (on `day`), `yearly` (on `month` + `day`). `interval` (1-99, default 1) applies to daily, weekly, monthly and yearly — every N days, weeks, months or years — and is stored only above 1. A missing anchor (`dow`, `day`, `month`) is taken from the task's date. Create and update reject an invalid rule with a 400.
**Tags**: a list of strings, or one comma-separated string. Normalised on create and update: trimmed, a leading `#` removed, lower case, whitespace runs become `-`, only letters, digits, `-` and `_`, at most 32 characters, at most 10 per task, duplicates dropped. Update replaces the list. Old files without `tags` load as `[]`. The next occurrence of a recurring task keeps its tags. `GET /api/tasks?tag=work` returns only tasks carrying that tag (`#WORK` matches `work`). Omit `tag` for the full list.

**MCP** (`bun-do-mcp`): `add_task` and `update_task` accept `tags`, `recurrence`, `amount` and `currency` (same rules as the API). `list_tasks` accepts an optional `tag`. A failed tool call returns a result with `isError: true`, not a JSON-RPC error.

## Backups

The server automatically backs up `tasks.json` and `projects.json` to `BUNDO_DATA_DIR/backups/` as `tasks-YYYY-MM-DD.json` (`projects-YYYY-MM-DD.json`) before the first write of each calendar day. Later writes that day leave it untouched.

- **Retention**: `BUNDO_BACKUP_KEEP` environment variable (default 30, whole number &ge; 1). Older files are deleted automatically.
- **Listing**: `GET /api/backups` returns backups newest first (`name`, `file`, `kind`, `date`, `size`, `entries`). CLI: `bun-do backups`.
- **Restoring**: `POST /api/backups/restore` with `{"file": "<name>"}` (must match backup filename pattern). Saves current data to `<kind>-YYYY-MM-DDTHHMMSS-before-restore.json` first, then loads backup into memory and disk. CLI: `bun-do restore <file>`.
- **Corrupt file safety**: If a data file fails to parse or has the wrong shape at startup, it is renamed to `<kind>.corrupt-<YYYYMMDD-HHMMSS>.json` (never overwritten), and the newest readable backup is loaded.

## Calendar feed (.ics)

`GET /calendar.ics` serves an RFC 5545 calendar feed (`Content-Type: text/calendar; charset=utf-8`) for calendar subscriptions (Apple Calendar, Outlook, Thunderbird).

- Includes open, dated tasks (backlog items `type=task` + `priority=P3` stay out).
- Events are all-day (`DTSTART;VALUE=DATE`, `DTEND;VALUE=DATE` next day).
- Properties: `UID:<id>@bun-do`, `DTSTAMP`, `SUMMARY` (payments: `Title - Currency Amount`), `DESCRIPTION` (notes), `CATEGORIES` (tags), `PRIORITY` (P0: 1, P1: 3, P2: 5, P3: 9).
- Reminders get one `VALARM` display alarm at 09:00 local time (`TRIGGER:PT9H`).
- Recurring tasks get an `RRULE` matching bun-do's recurrence rules.
- Optional query parameters: `types=` (comma-separated list of types) and `tag=` (normalised tag filter).
- Subscribe locally at `webcal://localhost:<port>/calendar.ics` or download the `.ics` file. Google Calendar cannot reach a local server, so Google users import the file.

## Curl patterns

### Before any operation — check server is up

```bash
curl -sf http://localhost:8000/api/tasks > /dev/null && echo "OK" || echo "Server not running — run: bun-do start"
```

### Add a task

```bash
curl -s -X POST http://localhost:8000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title": "Buy milk", "date": "2026-03-01", "priority": "P2"}'
```

### Add a recurring payment

```bash
curl -s -X POST http://localhost:8000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title": "Server hosting", "date": "2026-03-01", "priority": "P1", "type": "payment", "amount": "29", "currency": "USD", "recurrence": {"type": "monthly", "day": 1}}'
```

### Find task by title → get ID

```bash
curl -s http://localhost:8000/api/tasks | python3 -c "
import sys, json
for t in json.load(sys.stdin)['tasks']:
    if 'SEARCH' in t['title'].lower(): print(t['id'], t['title'])
"
```

### Edit (only send fields to change)

```bash
curl -s -X PUT http://localhost:8000/api/tasks/TASK_ID \
  -H 'Content-Type: application/json' \
  -d '{"priority": "P0", "date": "2026-03-15"}'
```

### Mark done

```bash
curl -s -X PUT http://localhost:8000/api/tasks/TASK_ID \
  -H 'Content-Type: application/json' \
  -d '{"done": true}'
```

### Delete

```bash
curl -s -X DELETE http://localhost:8000/api/tasks/TASK_ID
```

### Add subtask

```bash
curl -s -X POST http://localhost:8000/api/tasks/TASK_ID/subtasks \
  -H 'Content-Type: application/json' \
  -d '{"title": "Step one"}'
```

### Log project progress

```bash
curl -s -X POST http://localhost:8000/api/projects/PROJECT_ID/entries \
  -H 'Content-Type: application/json' \
  -d '{"summary": "Shipped v1.3 with MCP server and OpenClaw skill"}'
```

### List and restore backups

```bash
# List backups
curl -s http://localhost:8000/api/backups

# Restore backup
curl -s -X POST http://localhost:8000/api/backups/restore \
  -H 'Content-Type: application/json' \
  -d '{"file": "tasks-2026-01-05.json"}'
```

## Proactive patterns

Use these patterns for scheduled/autonomous behavior:

**Morning briefing**: GET `/api/tasks`, filter for today + overdue, summarize by priority.
**End of day**: Mark completed tasks done, add entries to active projects.
**Weekly review**: List all tasks, highlight overdue + P0/P1 without progress.
**Payment forecast**: List tasks where `type=payment`, group by month, sum amounts.

## Rules

- Always verify the server is running before any API call.
- Never guess IDs — search by title first, then use the UUID.
- Dates must be `YYYY-MM-DD`. Resolve "tomorrow", "next Monday", etc. before sending.
- Only send fields you want to change on PUT requests.
- The API returns the created/updated object on success.
- `GET /api/tasks` auto-carries overdue non-payment tasks to today.
