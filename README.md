# Reminder Agent

## What is it?

A smart scheduling assistant that lets you create tasks in plain English, automatically detects time conflicts, and sends timely reminders across desktop, browser, and Slack — so you act on things right when they start, not after.

---

## How it works

```
Add a task — structured form OR plain English ("Ask Agent")
                    ↓
Agent parses / validates the task
                    ↓
Checks for scheduling clashes with existing tasks
                    ↓
If clash found → suggests the next free time slot
   (critical-task clashes get an extra warning)
                    ↓
Task saved to the local schedule
                    ↓
Background daemon checks every minute
                    ↓
Reminder fired in 3 tiers, to the channels you picked:
  🕐 15 min before  →  Early warning
  ⚠️  5 min before   →  Urgent alert
  🚀 At start time   →  START NOW
        ↓ (per-task channels)
  🖥 Desktop   🌐 Browser   💬 Slack
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.10+, FastAPI |
| Server | Uvicorn (ASGI) |
| Data models | Pydantic v2 |
| Scheduler | APScheduler |
| Recurrence math | python-dateutil |
| Natural language parsing | Custom rule-based parser (regex, no external API) |
| Desktop notifications | Plyer |
| Browser notifications | Native Notification API + Server-Sent Events (SSE) |
| Slack notifications | Incoming Webhooks |
| Frontend | Vanilla HTML, CSS, JavaScript |
| Storage | JSON file (`data/tasks.json`) |
| Config | python-dotenv |

---

## Features

- **Natural language input** — "Ask Agent" turns a sentence like *"Study Python every Monday at 7 PM for 2 hours"* into a structured task you can review before saving
- **Clash detection** — warns you instantly if a new task overlaps an existing one
- **Auto free-slot suggestion** — finds the next available gap and offers to move the task there
- **Critical task protection** — editing a task that clashes with a critical-priority task shows a 🚨 warning and a one-click move button
- **Recurring tasks** — repeat daily, weekly, or monthly; the next occurrence is auto-created when you mark one done
- **3-tier reminders** — early warning, urgent alert, and a "start now" push at the exact moment
- **Per-task notification channels** — choose Desktop, Browser, and/or Slack independently for every task
- **Slack integration** — reminders posted to a Slack channel via Incoming Webhooks
- **Browser notifications** — in-page toasts + native OS notifications, even when the tab is in the background
- **Edit tasks** — change title, time, duration, priority, recurrence, channels, notes, or tags at any time
- **Dashboard** — tasks grouped by Today / Tomorrow / later, with live countdowns
- **Schedule audit** — full clash report for all upcoming tasks
- **Dark UI** — clean dashboard served at `http://localhost:3000`

---

## Setup

**Requirements:** Python 3.10+

```bash
# 1. Enter the project folder
cd reminder-agent

# 2. Install dependencies
pip install -r requirements.txt

# 3. Create your config from the sample
cp .env.sample .env
#    then edit .env if you want to change the port, timings, or enable Slack

# 4. Run
python app.py
```

Open your browser at **http://localhost:3000** (or whatever `PORT` you set).

When the page loads, click **Allow** when the browser asks for notification permission.

---

## Configuration (`.env`)

> `.env` holds secrets (your Slack webhook) and is **git-ignored**.
> Copy `.env.sample` → `.env` and fill in your values.

```env
PORT=3000                        # Web server port
REMINDER_LEAD_TIME_MINUTES=15    # First reminder: X min before task
REMINDER_URGENT_MINUTES=5        # Second reminder: X min before task
MIN_GAP_MINUTES=10               # Minimum buffer between tasks
DB_PATH=./data/tasks.json        # Where tasks are stored
DESKTOP_NOTIFICATIONS=true       # Enable OS-level notifications
SLACK_NOTIFICATIONS=false        # Enable Slack reminders
SLACK_WEBHOOK_URL=               # Your Slack Incoming Webhook URL
LOG_LEVEL=info                   # info | debug
```

### Enabling Slack

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**
2. Enable **Incoming Webhooks**, then **Add New Webhook to Workspace** and pick a channel
3. Copy the webhook URL (looks like `https://hooks.slack.com/services/T.../B.../xxxx`)
4. In `.env`, set `SLACK_NOTIFICATIONS=true` and paste the URL into `SLACK_WEBHOOK_URL`
5. Restart the server, then test it:
   ```bash
   curl -X POST http://localhost:3000/api/slack/test
   ```
   A "🔔 Reminder Agent connected" message should appear in your chosen channel.

Reminders only go to Slack for tasks where you tick the **💬 Slack** channel in the form.

---

## API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/tasks` | List upcoming tasks (`?all=true` for every task) |
| `POST` | `/api/tasks` | Create a task |
| `GET` | `/api/tasks/{id}` | Get a single task |
| `PATCH` | `/api/tasks/{id}` | Edit a task |
| `DELETE` | `/api/tasks/{id}` | Delete a task |
| `GET` | `/api/tasks/{id}/clash-check` | Check for clashes at a proposed time |
| `POST` | `/api/parse` | Parse a plain-English sentence into task fields |
| `POST` | `/api/slack/test` | Send a test message to the Slack webhook |
| `GET` | `/api/audit` | Full schedule clash report |
| `GET` | `/api/events` | SSE stream for live reminder notifications |

Interactive docs available at **http://localhost:3000/docs**

---

## Example

Using **Ask Agent**:

> "Remind me to finish my Python assignment tomorrow at 7 PM for one hour"

The agent parses this into:

```
Task:     Finish Python assignment
Date:     Tomorrow
Time:     7:00 PM
Duration: 60 min
Priority: Medium
```

Review, tick your notification channels (🖥 / 🌐 / 💬), and click **Schedule Task**.

Then, assuming default timings:

- **6:45 PM** → 🕐 early warning
- **6:55 PM** → ⚠️ urgent alert
- **7:00 PM** → 🚀 START NOW

…delivered to whichever channels you selected.

---

## Project structure

```
reminder-agent/
├── app.py                 # FastAPI entry point + API routes
├── requirements.txt
├── .env.sample            # Copy to .env and fill in
├── core/
│   ├── nlp.py             # Natural language parser
│   ├── reminder.py        # Background daemon + notification dispatch
│   ├── scheduler.py       # Clash detection, free-slot finder, recurrence
│   ├── slack.py           # Slack Incoming Webhook client
│   └── storage.py         # JSON persistence
├── models/
│   └── task.py            # Pydantic models
├── public/                # Frontend (index.html, app.js, style.css)
└── data/tasks.json        # Local task store (git-ignored)
```
