"""Background reminder engine using APScheduler."""

from __future__ import annotations

import json
import logging
import os
import queue
from datetime import datetime, timezone, timedelta
from typing import Iterator

from apscheduler.schedulers.background import BackgroundScheduler

from core.storage import load_tasks, update_task

logger = logging.getLogger("reminder")

_LEAD   = lambda: int(os.getenv("REMINDER_LEAD_TIME_MINUTES", "15"))
_URGENT = lambda: int(os.getenv("REMINDER_URGENT_MINUTES", "5"))
_NOTIFY = lambda: os.getenv("DESKTOP_NOTIFICATIONS", "true").lower() == "true"

# ── SSE event bus ─────────────────────────────────────────────────────
# Each connected browser client gets its own queue.
_subscribers: list[queue.Queue] = []


def subscribe() -> queue.Queue:
    """Register a new SSE subscriber. Returns a queue to read events from."""
    q: queue.Queue = queue.Queue(maxsize=20)
    _subscribers.append(q)
    return q


def unsubscribe(q: queue.Queue) -> None:
    """Remove a subscriber when the client disconnects."""
    try:
        _subscribers.remove(q)
    except ValueError:
        pass


def _broadcast(event_type: str, title: str, message: str, tier: str) -> None:
    """Push a reminder event to all connected browser clients."""
    payload = json.dumps({"type": event_type, "title": title, "message": message, "tier": tier})
    dead = []
    for q in _subscribers:
        try:
            q.put_nowait(payload)
        except queue.Full:
            dead.append(q)
    for q in dead:
        unsubscribe(q)


def sse_stream(q: queue.Queue) -> Iterator[str]:
    """Generator that yields SSE-formatted strings for a single client."""
    try:
        # Send a heartbeat immediately so the browser knows the connection is alive
        yield "event: ping\ndata: {}\n\n"
        while True:
            try:
                payload = q.get(timeout=25)   # 25s timeout → send keepalive
                yield f"event: reminder\ndata: {payload}\n\n"
            except queue.Empty:
                yield "event: ping\ndata: {}\n\n"   # keepalive
    finally:
        unsubscribe(q)


def _desktop_notify(title: str, message: str) -> None:
    if not _NOTIFY():
        return
    try:
        from plyer import notification
        notification.notify(title=title, message=message, timeout=8)
    except Exception:
        pass  # desktop notifications are best-effort


def _minutes_until(dt: datetime) -> float:
    now = datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (dt - now).total_seconds() / 60


def _tick() -> None:
    """Evaluate all tasks and fire reminders as needed. Called every minute."""
    try:
        tasks = load_tasks()
    except Exception as e:
        logger.error("Failed to load tasks: %s", e)
        return

    for task in tasks:
        if task.completed:
            continue

        mins = _minutes_until(task.start_time)
        changed = False

        # Overdue — auto-complete
        if mins < -task.duration:
            task.completed = True
            update_task(task)
            logger.debug("Auto-completed overdue task: %s", task.title)
            continue

        # Tier 1 — Early warning
        if not task.reminded.early and _URGENT() < mins <= _LEAD():
            msg = f"Starts in ~{int(mins)} min • {task.duration} min long"
            logger.info("[EARLY] %s — %s", task.title, msg)
            _desktop_notify(f"🕐 Upcoming: {task.title}", msg)
            _broadcast("early", f"🕐 Upcoming: {task.title}", msg, "early")
            task.reminded.early = True
            changed = True

        # Tier 2 — Urgent
        elif not task.reminded.urgent and 0 < mins <= _URGENT():
            msg = f"Only {int(mins)} minute(s) away — get ready NOW!"
            logger.info("[URGENT] %s — %s", task.title, msg)
            _desktop_notify(f"⚠️  Starting soon: {task.title}", msg)
            _broadcast("urgent", f"⚠️ Starting soon: {task.title}", msg, "urgent")
            task.reminded.urgent = True
            changed = True

        # Tier 3 — Start now (within ±1 min of start)
        elif not task.reminded.start and -1 <= mins <= 0:
            msg = f"Do it right now! Duration: {task.duration} min"
            logger.info("[START NOW] %s — %s", task.title, msg)
            _desktop_notify(f"🚀 START NOW: {task.title}", msg)
            _broadcast("start", f"🚀 START NOW: {task.title}", msg, "start")
            task.reminded.start = True
            changed = True

        if changed:
            update_task(task)


# ── Public API ────────────────────────────────────────────────────────

_scheduler: BackgroundScheduler | None = None


def start_reminder_daemon() -> None:
    global _scheduler
    if _scheduler and _scheduler.running:
        return

    _scheduler = BackgroundScheduler(timezone="UTC")
    _scheduler.add_job(_tick, trigger="interval", minutes=1, id="reminder_tick")
    _scheduler.start()

    # Run one pass immediately
    _tick()
    logger.info(
        "Reminder daemon started (lead=%dmin, urgent=%dmin)",
        _LEAD(), _URGENT(),
    )


def stop_reminder_daemon() -> None:
    global _scheduler
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
        logger.info("Reminder daemon stopped.")
