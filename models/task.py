from __future__ import annotations

import uuid
from datetime import datetime, timezone, timedelta
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, model_validator


class Priority(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class ReminderState(BaseModel):
    early: bool = False
    urgent: bool = False
    start: bool = False


class Task(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    title: str
    start_time: datetime          # stored as UTC-aware datetime
    end_time: datetime            # computed: start_time + duration
    duration: int                 # minutes
    priority: Priority = Priority.MEDIUM
    notes: str = ""
    tags: list[str] = []
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    reminded: ReminderState = Field(default_factory=ReminderState)
    completed: bool = False

    @model_validator(mode="before")
    @classmethod
    def compute_end_time(cls, values: dict) -> dict:
        """Auto-compute end_time from start_time + duration if not provided."""
        st = values.get("start_time")
        dur = values.get("duration")
        if st and dur and "end_time" not in values:
            if isinstance(st, str):
                st = datetime.fromisoformat(st)
            if st.tzinfo is None:
                st = st.replace(tzinfo=timezone.utc)
            values["end_time"] = st + timedelta(minutes=int(dur))
        return values

    model_config = {"json_encoders": {datetime: lambda v: v.isoformat()}}


class TaskCreate(BaseModel):
    """Payload accepted by POST /api/tasks."""
    title: str = Field(..., min_length=1, max_length=200)
    start_time: datetime
    duration: int = Field(..., gt=0, le=1440, description="Duration in minutes (1–1440)")
    priority: Priority = Priority.MEDIUM
    notes: str = ""
    tags: list[str] = []
    auto_resolve: bool = False    # if True, auto-move to free slot on clash

    @model_validator(mode="after")
    def start_must_be_future(self) -> "TaskCreate":
        now = datetime.now(timezone.utc)
        st = self.start_time
        if st.tzinfo is None:
            st = st.replace(tzinfo=timezone.utc)
        if st <= now:
            raise ValueError("Start time must be in the future — please pick a later time")
        return self


class TaskPatch(BaseModel):
    """Payload accepted by PATCH /api/tasks/{id}."""
    title: Optional[str] = None
    start_time: Optional[datetime] = None
    duration: Optional[int] = None
    notes: Optional[str] = None
    priority: Optional[Priority] = None
    tags: Optional[list[str]] = None
    completed: Optional[bool] = None
