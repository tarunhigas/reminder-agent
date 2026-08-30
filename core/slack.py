"""
Slack notifications via Incoming Webhooks.

Setup:
  1. Go to https://api.slack.com/apps → Create New App → From scratch
  2. Enable "Incoming Webhooks" → Add New Webhook to Workspace
  3. Pick a channel, copy the webhook URL
  4. Paste it into .env as SLACK_WEBHOOK_URL

No token or SDK needed — a webhook is just a POST endpoint.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.request
import urllib.error

logger = logging.getLogger("slack")

_WEBHOOK = lambda: os.getenv("SLACK_WEBHOOK_URL", "").strip()
_ENABLED = lambda: os.getenv("SLACK_NOTIFICATIONS", "false").lower() == "true"

# Colour bar shown on the left of each Slack attachment, per reminder tier.
_TIER_COLOR = {
    "early":  "#6c63ff",   # purple
    "urgent": "#f0a500",   # amber
    "start":  "#4caf7d",   # green
}


def slack_enabled() -> bool:
    """True only when notifications are turned on AND a webhook URL is set."""
    return _ENABLED() and bool(_WEBHOOK())


def _post(payload: dict) -> bool:
    """POST a JSON payload to the configured webhook. Returns success bool."""
    url = _WEBHOOK()
    if not url:
        return False

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return resp.status == 200
    except urllib.error.URLError as e:
        logger.warning("Slack post failed: %s", e)
        return False
    except Exception as e:  # noqa: BLE001 — best-effort, never crash the daemon
        logger.warning("Slack post error: %s", e)
        return False


def notify_slack(title: str, message: str, tier: str = "early") -> bool:
    """
    Send a reminder to Slack as a formatted attachment.
    Silently no-ops if Slack is not configured.
    """
    if not slack_enabled():
        return False

    payload = {
        "attachments": [
            {
                "color": _TIER_COLOR.get(tier, "#6c63ff"),
                "blocks": [
                    {
                        "type": "section",
                        "text": {"type": "mrkdwn", "text": f"*{title}*\n{message}"},
                    }
                ],
                "fallback": f"{title} — {message}",
            }
        ]
    }
    return _post(payload)


def send_test_message() -> bool:
    """Send a one-off test message to confirm the webhook works."""
    if not slack_enabled():
        logger.info("Slack not enabled or webhook URL missing.")
        return False
    return notify_slack(
        "🔔 Reminder Agent connected",
        "Slack notifications are working. You'll get task reminders here.",
        tier="start",
    )
