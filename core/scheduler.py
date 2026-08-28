"""Clash detection and free-slot finder."""

from __future__ import annotations

import os
from datetime import datetime, timezone, timedelta

from models.task import Task, TaskCreate
from core.storage import load_tasks, add_task

_GAP = lambda: int(os.getenv("MIN_GAP_MINUTES", "10"))


def tasks_overlap(a: Task, b: Task, gap_minutes: int | None = None) -> bool:
    """Return True if tasks a and b overlap (including the required gap buffer)."""
    gap = timedelta(minutes=gap_minutes if gap_minutes is not None else _GAP())
    a_start = a.start_time
    a_end   = a.end_time + gap
    b_start = b.start_time
    b_end   = b.end_time + gap
    return a_start < b_end and b_start < a_end


def find_next_free_slot(
    tasks: list[Task],
    duration_minutes: int,
    after: datetime | None = None,
) -> datetime:
    """
    Find the earliest datetime where a task of `duration_minutes` fits
    without clashing with any existing task (+ gap buffer).
    """
    gap = timedelta(minutes=_GAP())
    dur = timedelta(minutes=duration_minutes)

    candidate = after or datetime.now(timezone.utc)
    if candidate.tzinfo is None:
        candidate = candidate.replace(tzinfo=timezone.utc)

    # Round up to next 5-minute boundary
    remainder = candidate.minute % 5
    if remainder:
        candidate += timedelta(minutes=5 - remainder)
    candidate = candidate.replace(second=0, microsecond=0)

    upcoming = sorted(
        [t for t in tasks if not t.completed],
        key=lambda t: t.start_time,
    )

    # Walk through tasks and push candidate forward on each clash
    changed = True
    while changed:
        changed = False
        for task in upcoming:
            clash_start = task.start_time - gap
            clash_end   = task.end_time + gap
            cand_end    = candidate + dur

            if candidate < clash_end and cand_end > clash_start:
                # Push past this task's end + gap
                candidate = task.end_time + gap
                remainder = candidate.minute % 5
                if remainder:
                    candidate += timedelta(minutes=5 - remainder)
                candidate = candidate.replace(second=0, microsecond=0)
                changed = True
                break  # restart scan

    return candidate


def detect_clashes(payload: TaskCreate) -> tuple[list[Task], datetime | None]:
    """
    Check payload against all existing tasks.
    Returns (clashing_tasks, suggested_free_slot).
    suggested_free_slot is None if no clashes.
    """
    existing = load_tasks()

    # Build a temporary Task to get end_time
    candidate = Task(
        title=payload.title,
        start_time=payload.start_time,
        duration=payload.duration,
        priority=payload.priority,
        notes=payload.notes,
        tags=payload.tags,
    )

    clashes = [
        t for t in existing
        if not t.completed and tasks_overlap(t, candidate)
    ]

    suggestion = None
    if clashes:
        suggestion = find_next_free_slot(
            existing, payload.duration, after=payload.start_time
        )

    return clashes, suggestion


def schedule_task(payload: TaskCreate, auto_resolve: bool = False) -> tuple[Task | None, list[Task], datetime | None, bool]:
    """
    Create and persist a task, handling clashes.

    Returns (task, clashes, suggestion, resolved).
    If clashes exist and auto_resolve=False, task=None and caller must decide.
    """
    clashes, suggestion = detect_clashes(payload)

    if clashes and not auto_resolve:
        return None, clashes, suggestion, False

    start = suggestion if (clashes and auto_resolve) else payload.start_time

    task = Task(
        title=payload.title,
        start_time=start,
        duration=payload.duration,
        priority=payload.priority,
        notes=payload.notes,
        tags=payload.tags,
    )
    add_task(task)
    return task, clashes, suggestion, bool(clashes and auto_resolve)


def audit_schedule() -> tuple[list[Task], list[tuple[Task, Task]]]:
    """Return upcoming tasks and all clashing pairs."""
    from core.storage import get_upcoming_tasks
    tasks = get_upcoming_tasks()
    clash_pairs = []
    for i in range(len(tasks)):
        for j in range(i + 1, len(tasks)):
            if tasks_overlap(tasks[i], tasks[j]):
                clash_pairs.append((tasks[i], tasks[j]))
    return tasks, clash_pairs
