"""
Reminder Agent — FastAPI entry point
Run: python app.py
UI:  http://localhost:3000
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from datetime import timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from models.task import Task, TaskCreate, TaskPatch
from core.storage import (
    load_tasks, get_upcoming_tasks, find_task_by_id,
    add_task, remove_task, update_task,
)
from core.scheduler import detect_clashes, schedule_task, audit_schedule
from core.reminder import start_reminder_daemon, stop_reminder_daemon, subscribe, sse_stream

# ── Logging ───────────────────────────────────────────────────────────
log_level = logging.DEBUG if os.getenv("LOG_LEVEL", "info") == "debug" else logging.INFO
logging.basicConfig(
    level=log_level,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("app")

PORT = int(os.getenv("PORT", "3000"))
PUBLIC = Path(__file__).parent / "public"


# ── Lifespan (startup / shutdown) ─────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("🚀  Starting Reminder Agent on http://localhost:%d", PORT)
    start_reminder_daemon()
    yield
    stop_reminder_daemon()
    logger.info("👋  Reminder Agent stopped.")


# ── App ────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Reminder Agent",
    description="Smart schedule reminder — clash detection, tiered reminders",
    version="1.0.0",
    lifespan=lifespan,
)


# Flatten Pydantic 422 validation errors into a simple {"error": "..."} response
@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    messages = []
    for err in exc.errors():
        msg = err.get("msg", "Validation error")
        # Strip pydantic's "Value error, " prefix
        msg = msg.replace("Value error, ", "")
        messages.append(msg)
    return JSONResponse(status_code=422, content={"error": "; ".join(messages)})


# ── Helpers ────────────────────────────────────────────────────────────
def _enrich(task: Task, clash_ids: set[str]) -> dict:
    """Add display fields to a task dict for the frontend."""
    d = task.model_dump(mode="json")
    d["hasClash"]    = task.id in clash_ids
    d["displayStart"] = task.start_time.strftime("%a, %b %-d %Y • %-I:%M %p")
    d["fromNow"]     = _from_now(task.start_time)
    return d


def _from_now(dt) -> str:
    from datetime import datetime
    now = datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    diff = dt - now
    total = int(diff.total_seconds())
    if total < 0:
        secs = abs(total)
        if secs < 3600:   return f"{secs // 60} min ago"
        if secs < 86400:  return f"{secs // 3600} hr ago"
        return f"{secs // 86400} days ago"
    if total < 60:     return "just now"
    if total < 3600:   return f"in {total // 60} min"
    if total < 86400:  return f"in {total // 3600} hr"
    return f"in {total // 86400} days"


# ── API Routes ─────────────────────────────────────────────────────────

@app.get("/api/tasks")
async def list_tasks(all: bool = False) -> dict:
    tasks = load_tasks() if all else get_upcoming_tasks()
    _, clash_pairs = audit_schedule()
    clash_ids = {t.id for pair in clash_pairs for t in pair}
    return {
        "tasks": [_enrich(t, clash_ids) for t in tasks],
        "clashCount": len(clash_pairs),
    }


@app.post("/api/tasks", status_code=201)
async def create_task(payload: TaskCreate) -> Any:
    # If auto_resolve is False, check first and return 409 on clash
    if not payload.auto_resolve:
        clashes, suggestion = detect_clashes(payload)
        if clashes:
            return JSONResponse(
                status_code=409,
                content={
                    "clash": True,
                    "clashes": [
                        {
                            "id": c.id,
                            "title": c.title,
                            "displayStart": c.start_time.strftime("%a, %b %-d %Y • %-I:%M %p"),
                        }
                        for c in clashes
                    ],
                    "suggestion": {
                        "iso": suggestion.isoformat(),
                        "display": suggestion.strftime("%a, %b %-d %Y • %-I:%M %p"),
                    },
                },
            )

    task, clashes, suggestion, resolved = schedule_task(payload, auto_resolve=payload.auto_resolve)
    return {"task": task.model_dump(mode="json")}


@app.get("/api/tasks/{task_id}")
async def get_task(task_id: str) -> dict:
    task = find_task_by_id(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"task": task.model_dump(mode="json")}


@app.patch("/api/tasks/{task_id}")
async def patch_task(task_id: str, patch: TaskPatch) -> dict:
    task = find_task_by_id(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    data = task.model_dump()
    for field, value in patch.model_dump(exclude_unset=True).items():
        data[field] = value

    # Recompute end_time if start_time or duration changed
    if patch.start_time is not None or patch.duration is not None:
        from datetime import timedelta
        st  = data["start_time"]
        dur = data["duration"]
        if isinstance(st, str):
            from datetime import datetime as _dt
            st = _dt.fromisoformat(st)
        data["end_time"] = st + timedelta(minutes=int(dur))
        # Reset reminder flags so the new time triggers fresh reminders
        data["reminded"] = {"early": False, "urgent": False, "start": False}

    updated = Task.model_validate(data)
    update_task(updated)
    return {"task": updated.model_dump(mode="json")}


@app.get("/api/tasks/{task_id}/clash-check")
async def clash_check(task_id: str, start_time: str, duration: int) -> dict:
    """
    Check if a proposed reschedule clashes with other tasks.
    Returns clashing tasks (with priority) and the next free slot suggestion.
    Used by the edit modal before saving.
    """
    from datetime import datetime as _dt
    from core.scheduler import find_next_free_slot, tasks_overlap
    from models.task import Task as _Task

    existing = load_tasks()

    # Parse the proposed start time
    try:
        proposed_start = _dt.fromisoformat(start_time)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid start_time format")

    # Build a temporary task to check overlaps against
    from datetime import timedelta
    proposed_end = proposed_start + timedelta(minutes=duration)

    # Temporary task object for overlap checking
    temp = _Task(
        title="__temp__",
        start_time=proposed_start,
        duration=duration,
    )

    # Find clashes (exclude the task being edited)
    clashes = [
        t for t in existing
        if t.id != task_id and not t.completed and tasks_overlap(t, temp)
    ]

    has_critical_clash = any(t.priority == "critical" for t in clashes)

    # Suggest next free slot (excluding the task being edited)
    others = [t for t in existing if t.id != task_id]
    suggestion = find_next_free_slot(others, duration, after=proposed_start)

    return {
        "clashes": [
            {
                "id": c.id,
                "title": c.title,
                "priority": c.priority,
                "displayStart": c.start_time.strftime("%a, %b %-d %Y • %-I:%M %p"),
            }
            for c in clashes
        ],
        "hasCriticalClash": has_critical_clash,
        "suggestion": {
            "iso": suggestion.isoformat(),
            "display": suggestion.strftime("%a, %b %-d %Y • %-I:%M %p"),
        },
    }


@app.delete("/api/tasks/{task_id}")
async def delete_task(task_id: str) -> dict:
    removed, _ = remove_task(task_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"success": True}


@app.get("/api/audit")
async def audit() -> dict:
    tasks, clash_pairs = audit_schedule()
    return {
        "taskCount": len(tasks),
        "clashCount": len(clash_pairs),
        "clashes": [
            {
                "a": {"id": a.id, "title": a.title, "displayStart": a.start_time.strftime("%a, %b %-d %Y • %-I:%M %p")},
                "b": {"id": b.id, "title": b.title, "displayStart": b.start_time.strftime("%a, %b %-d %Y • %-I:%M %p")},
            }
            for a, b in clash_pairs
        ],
    }


@app.get("/api/events")
async def sse_endpoint(request: Request):
    """Server-Sent Events stream — pushes reminder notifications to the browser."""
    q = subscribe()
    return StreamingResponse(
        sse_stream(q),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # disable nginx buffering if behind a proxy
            "Connection": "keep-alive",
        },
    )


# ── Static frontend ────────────────────────────────────────────────────
# Serve root and SPA fallback before mounting static files
if PUBLIC.exists():
    @app.get("/", include_in_schema=False)
    async def root():
        return FileResponse(PUBLIC / "index.html")

    @app.get("/app.js", include_in_schema=False)
    async def serve_js():
        return FileResponse(PUBLIC / "app.js", media_type="application/javascript")

    @app.get("/style.css", include_in_schema=False)
    async def serve_css():
        return FileResponse(PUBLIC / "style.css", media_type="text/css")

    # Mount remaining static assets
    app.mount("/", StaticFiles(directory=PUBLIC, html=True), name="static")


# ── Entry point ────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    print(f"\n  🗓  Reminder Agent\n  → http://localhost:{PORT}\n  → API docs: http://localhost:{PORT}/docs\n")
    uvicorn.run("app:app", host="0.0.0.0", port=PORT, reload=False)
