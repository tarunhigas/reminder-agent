"""
Natural language parser for task creation.
No external APIs — pure regex + rule-based extraction.

Supports inputs like:
  "Remind me to finish Python assignment tomorrow at 7 PM for 1 hour"
  "Study maths on Monday at 6:30 pm for 45 minutes, high priority"
  "Team meeting next Friday at 2pm, 30 min, critical"
  "Submit report in 3 days at 10am"
  "Call John today at 3:30 PM for 20 minutes"
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone, date
from typing import Optional


# ── Helpers ───────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.now(timezone.utc)

def _today() -> date:
    return datetime.now().date()


# ── Date extraction ───────────────────────────────────────────────────

_WEEKDAYS = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
    "mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6,
}

_MONTH_NAMES = {
    "january": 1, "february": 2, "march": 3, "april": 4,
    "may": 5, "june": 6, "july": 7, "august": 8,
    "september": 9, "october": 10, "november": 11, "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}

def _extract_date(text: str) -> tuple[Optional[date], str]:
    """
    Return (parsed_date, cleaned_text_with_date_removed).
    """
    t = text.lower()
    today = _today()

    # today / tonight
    if re.search(r'\btoday\b|\btonight\b', t):
        cleaned = re.sub(r'\b(today|tonight)\b', '', text, flags=re.IGNORECASE).strip()
        return today, cleaned

    # tomorrow
    if re.search(r'\btomorrow\b', t):
        cleaned = re.sub(r'\btomorrow\b', '', text, flags=re.IGNORECASE).strip()
        return today + timedelta(days=1), cleaned

    # "in X days"
    m = re.search(r'\bin\s+(\d+)\s+days?\b', t)
    if m:
        cleaned = re.sub(r'\bin\s+\d+\s+days?\b', '', text, flags=re.IGNORECASE).strip()
        return today + timedelta(days=int(m.group(1))), cleaned

    # "next <weekday>" or "<weekday>"
    for name, wd in _WEEKDAYS.items():
        pattern = rf'\b(?:next\s+)?{name}\b'
        if re.search(pattern, t):
            days_ahead = (wd - today.weekday() + 7) % 7
            if days_ahead == 0:
                days_ahead = 7   # "next monday" when today is monday → 7 days
            cleaned = re.sub(pattern, '', text, flags=re.IGNORECASE).strip()
            return today + timedelta(days=days_ahead), cleaned

    # explicit date: "Aug 30", "30 Aug", "August 30", "2026-08-30", "08/30"
    m = re.search(
        r'\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b', t)
    if m:
        month, day = int(m.group(1)), int(m.group(2))
        year = int(m.group(3)) if m.group(3) else today.year
        if year < 100:
            year += 2000
        try:
            d = date(year, month, day)
            cleaned = re.sub(
                r'\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?\b', '', text, flags=re.IGNORECASE).strip()
            return d, cleaned
        except ValueError:
            pass

    for month_name, month_num in _MONTH_NAMES.items():
        m = re.search(rf'\b{month_name}\s+(\d{{1,2}})\b', t)
        if m:
            day = int(m.group(1))
            try:
                d = date(today.year, month_num, day)
                if d < today:
                    d = date(today.year + 1, month_num, day)
                cleaned = re.sub(
                    rf'\b{month_name}\s+\d{{1,2}}\b', '', text, flags=re.IGNORECASE).strip()
                return d, cleaned
            except ValueError:
                pass

    # default → today
    return today, text


# ── Time extraction ───────────────────────────────────────────────────

def _extract_time(text: str) -> tuple[Optional[str], str]:
    """
    Return (HH:MM string in 24h, cleaned_text).
    """
    # HH:MM am/pm  or  HH am/pm
    m = re.search(
        r'\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b', text, re.IGNORECASE)
    if m:
        hour   = int(m.group(1))
        minute = int(m.group(2)) if m.group(2) else 0
        ampm   = m.group(3).lower()
        if ampm == 'pm' and hour != 12:
            hour += 12
        if ampm == 'am' and hour == 12:
            hour = 0
        cleaned = re.sub(
            r'\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b', '', text, flags=re.IGNORECASE).strip()
        return f"{hour:02d}:{minute:02d}", cleaned

    # 24-hour HH:MM (e.g. 14:30, 07:00)
    m = re.search(r'\b([01]?\d|2[0-3]):([0-5]\d)\b', text)
    if m:
        cleaned = re.sub(r'\b(?:[01]?\d|2[0-3]):[0-5]\d\b', '', text).strip()
        return f"{int(m.group(1)):02d}:{m.group(2)}", cleaned

    return None, text


# ── Duration extraction ───────────────────────────────────────────────

def _extract_duration(text: str) -> tuple[int, str]:
    """
    Return (minutes, cleaned_text). Default 30 min.
    """
    t = text.lower()

    # "1 hour 30 minutes", "1.5 hours", "90 minutes", "2 hrs"
    m = re.search(
        r'\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:and\s+)?(?:(\d+)\s*(?:minutes?|mins?))?\b', t)
    if m:
        hours = float(m.group(1))
        mins  = int(m.group(2)) if m.group(2) else 0
        total = int(hours * 60) + mins
        cleaned = re.sub(
            r'\b\d+(?:\.\d+)?\s*(?:hours?|hrs?)\s*(?:and\s+)?\d*\s*(?:minutes?|mins?)?\b',
            '', text, flags=re.IGNORECASE).strip()
        return max(total, 1), cleaned

    # "45 minutes", "30 min"
    m = re.search(r'\b(\d+)\s*(?:minutes?|mins?)\b', t)
    if m:
        total = int(m.group(1))
        cleaned = re.sub(r'\b\d+\s*(?:minutes?|mins?)\b', '', text, flags=re.IGNORECASE).strip()
        return max(total, 1), cleaned

    return 30, text


# ── Priority extraction ───────────────────────────────────────────────

_PRIORITY_WORDS = {
    "critical": "critical", "urgent": "critical", "asap": "critical",
    "high":     "high",     "important": "high",
    "low":      "low",      "whenever": "low",    "someday": "low",
    "medium":   "medium",   "normal": "medium",
}

def _extract_priority(text: str) -> tuple[str, str]:
    t = text.lower()
    for word, level in _PRIORITY_WORDS.items():
        if re.search(rf'\b{word}\b', t):
            cleaned = re.sub(rf'\b{word}\b', '', text, flags=re.IGNORECASE).strip()
            return level, cleaned
    return "medium", text


# ── Title cleanup ─────────────────────────────────────────────────────

# Filler phrases to strip before/after extracting fields
_FILLERS = [
    r"remind(?:er)?\s+(?:me\s+)?(?:to\s+)?",
    r"(?:please\s+)?(?:schedule|add|create|set(?:\s+up)?)\s+(?:a\s+)?(?:reminder|task|event)?\s*(?:to\s+|for\s+)?",
    r"i\s+(?:need\s+to|have\s+to|must|should)\s+",
    r"don't\s+(?:let\s+me\s+)?forget\s+(?:to\s+)?",
    r"\bevery\b",
    r"\bat\b\s*$",
    r"\bfor\b\s*$",
    r"^\s*(?:a|an|the)\s+",
    r",\s*$",
    r"\s*,\s*$",
]

def _clean_title(text: str) -> str:
    t = text.strip()
    for pattern in _FILLERS:
        t = re.sub(pattern, '', t, flags=re.IGNORECASE).strip()
    # Remove trailing orphaned words like "at", "for", "on", "by"
    t = re.sub(r'\s+\b(at|for|on|by|in|to|the|a|an)\b\s*$', '', t, flags=re.IGNORECASE).strip()
    # Collapse multiple spaces and strip punctuation
    t = re.sub(r'\s{2,}', ' ', t).strip(' ,.-')
    return t[:1].upper() + t[1:] if t else "Untitled Task"


# ── Main parse function ───────────────────────────────────────────────

def parse_task_text(text: str) -> dict:
    """
    Parse a natural language string into structured task fields.

    Returns:
        {
          "title":      str,
          "date":       "YYYY-MM-DD",
          "time":       "HH:MM" | None,
          "duration":   int (minutes),
          "priority":   "low" | "medium" | "high" | "critical",
          "confidence": "high" | "medium" | "low",
          "raw":        original text
        }
    """
    raw = text.strip()
    working = raw

    # Extract each field, consuming the matched portion from working text
    parsed_date, working = _extract_date(working)
    parsed_time, working = _extract_time(working)
    duration,    working = _extract_duration(working)
    priority,    working = _extract_priority(working)
    title = _clean_title(working)

    # Confidence score
    has_time = parsed_time is not None
    has_explicit_date = parsed_date != _today()  # anything other than default
    confidence = "high" if (has_time and title) else ("medium" if title else "low")

    return {
        "title":      title,
        "date":       parsed_date.isoformat(),
        "time":       parsed_time,
        "duration":   duration,
        "priority":   priority,
        "confidence": confidence,
        "raw":        raw,
    }
