# Reminder Agent

## What is it?

A smart scheduling assistant that lets you create tasks, automatically detects time conflicts, and sends you timely browser and desktop notifications so you act on things right when they start — not after.

---

## How it works

```
User adds a task (title, date, time, duration, priority)
                    ↓
Agent checks for scheduling clashes with existing tasks
                    ↓
If clash found → suggests next free time slot
                    ↓
Task saved to local schedule
                    ↓
Background daemon checks every minute
                    ↓
Reminder fired in 3 tiers:
  🕐 15 min before  →  Early warning
  ⚠️  5 min before   →  Urgent alert
  🚀 At start time   →  START NOW (browser + desktop notification)
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12, FastAPI |
| Server | Uvicorn (ASGI) |
| Data models | Pydantic v2 |
| Scheduler | APScheduler |
| Desktop notifications | Plyer |
| Browser notifications | Native Notification API + Server-Sent Events (SSE) |
| Frontend | Vanilla HTML, CSS, JavaScript |
| Storage | JSON file (`data/tasks.json`) |
| Config | python-dotenv |

---

## Features

- **Clash detection** — warns you instantly if a new task overlaps an existing one
- **Auto free-slot suggestion** — finds the next available gap and offers to move the task there
- **Critical task protection** — editing a task that clashes with a critical-priority task shows a 🚨 warning and a one-click move button
- **3-tier reminders** — early warning, urgent alert, and a "start now" push at the exact moment
- **Browser notifications** — in-page toasts + native OS notifications so you're alerted even when the tab is in the background
- **Edit tasks** — change title, time, duration, priority, notes, or tags at any time
- **Mark complete / delete** — keep your schedule clean
- **Schedule audit** — see a full clash report for all upcoming tasks
- **Dark UI** — clean dashboard at `http://localhost:3000`

---

## Setup

**Requirements:** Python 3.10+

```bash
# 1. Clone or enter the project folder
cd reminder-agent

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure (optional — defaults work out of the box)
# Edit .env to change port, reminder lead times, timezone, etc.

# 4. Run
python app.py
```

Open your browser at **http://localhost:3000**

When the page loads, click **Allow** when the browser asks for notification permission.

---

## Configuration (`.env`)

```env
PORT=3000                        # Web server port
REMINDER_LEAD_TIME_MINUTES=15    # First reminder: X min before task
REMINDER_URGENT_MINUTES=5        # Second reminder: X min before task
MIN_GAP_MINUTES=10               # Minimum buffer between tasks
DB_PATH=./data/tasks.json        # Where tasks are stored
DESKTOP_NOTIFICATIONS=true       # Enable OS-level notifications
LOG_LEVEL=info                   # info | debug
```

---

## API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/tasks` | List upcoming tasks |
| `POST` | `/api/tasks` | Create a task |
| `GET` | `/api/tasks/{id}` | Get a single task |
| `PATCH` | `/api/tasks/{id}` | Edit a task |
| `DELETE` | `/api/tasks/{id}` | Delete a task |
| `GET` | `/api/tasks/{id}/clash-check` | Check for clashes at a proposed time |
| `GET` | `/api/audit` | Full schedule clash report |
| `GET` | `/api/events` | SSE stream for live reminder notifications |

Interactive docs available at **http://localhost:3000/docs**

---

## Example

> "Remind me to submit my assignment tomorrow at 6 PM"

1. Click **+ Add Task**
2. Title: `Submit assignment`
3. Date: tomorrow's date
4. Start time: `18:00`
5. Duration: `30` min
6. Priority: `high`
7. Click **Schedule Task**

At **5:45 PM** → 🕐 early warning toast + browser notification  
At **5:55 PM** → ⚠️ urgent alert  
At **6:00 PM** → 🚀 "START NOW" notification that stays on screen until dismissed
