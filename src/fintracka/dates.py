from __future__ import annotations

from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

REPORTING_ZONE = ZoneInfo("America/New_York")


def utc_instant(value: str | datetime) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
    if parsed.tzinfo is None:
        raise ValueError("provider timestamps must include an offset")
    return parsed.astimezone(timezone.utc)


def local_date(value: str | datetime) -> date:
    return utc_instant(value).astimezone(REPORTING_ZONE).date()

