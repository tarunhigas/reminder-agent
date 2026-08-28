"""JSON-file persistence layer for tasks."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from models.task import Task

_DB_PATH = Path(os.getenv("DB_PATH", "./data/tasks.json"))


def _ensure_db() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not _DB_PATH.exists():
        _DB_PATH.write_text(json.dumps({"tasks": []}, indent=2))


def _load_raw() -> list[dict]:
    _ensure_db()
    data = json.loads(_DB_PATH.read_text())
    return data.get("tasks", [])


def _save_raw(tasks: list[dict]) -> None:
    _ensure_db()
    _DB_PATH.write_text(json.dumps({"tasks": tasks}, indent=2, default=str))


# ── Public API ────────────────────────────────────────────────────────

def load_tasks() -> list[Task]:
    return [Task.model_validate(t) for t in _load_raw()]


def save_tasks(tasks: list[Task]) -> None:
    _save_raw([json.loads(t.model_dump_json()) for t in tasks])


def add_task(task: Task) -> list[Task]:
    tasks = load_tasks()
    tasks.append(task)
    save_tasks(tasks)
    return tasks


def remove_task(task_id: str) -> tuple[bool, list[Task]]:
    tasks = load_tasks()
    updated = [t for t in tasks if t.id != task_id]
    removed = len(updated) < len(tasks)
    if removed:
        save_tasks(updated)
    return removed, updated


def update_task(updated: Task) -> list[Task]:
    tasks = load_tasks()
    for i, t in enumerate(tasks):
        if t.id == updated.id:
            tasks[i] = updated
            save_tasks(tasks)
            return tasks
    raise ValueError(f"Task {updated.id} not found")


def find_task_by_id(task_id: str) -> Optional[Task]:
    return next((t for t in load_tasks() if t.id == task_id), None)


def get_upcoming_tasks() -> list[Task]:
    now = datetime.now(timezone.utc)
    return sorted(
        [t for t in load_tasks() if not t.completed and t.start_time > now],
        key=lambda t: t.start_time,
    )
