"""High-impact news check using the public Forex Factory weekly calendar feed."""

import time as _time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import httpx

FEED_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
_CACHE_TTL = 30 * 60  # the feed is rate limited; refresh at most every 30 min
_cache: tuple[float, list[dict]] | None = None

# Currencies that move each non-forex instrument
_SYMBOL_CURRENCIES = {
    "XAU": {"USD"}, "XAG": {"USD"}, "GOLD": {"USD"}, "SILVER": {"USD"},
    "BTC": {"USD"}, "ETH": {"USD"}, "OIL": {"USD"}, "WTI": {"USD"}, "USOIL": {"USD"},
    "US30": {"USD"}, "NAS": {"USD"}, "NAS100": {"USD"}, "US100": {"USD"},
    "SPX": {"USD"}, "US500": {"USD"}, "DXY": {"USD"},
    "GER40": {"EUR"}, "DE40": {"EUR"}, "DAX": {"EUR"}, "UK100": {"GBP"},
    "JP225": {"JPY"}, "NIKKEI": {"JPY"},
}


@dataclass
class NewsEvent:
    when: datetime
    country: str
    title: str
    impact: str


def symbol_currencies(symbol: str | None) -> set[str] | None:
    """Currencies relevant to a symbol; None means 'check all currencies'."""
    if not symbol:
        return None
    s = symbol.upper().replace("/", "").replace("_", "")
    for prefix, cur in _SYMBOL_CURRENCIES.items():
        if s.startswith(prefix):
            return cur
    if len(s) == 6 and s.isalpha():
        return {s[:3], s[3:]}
    return None


def parse_events(raw: list[dict]) -> list[NewsEvent]:
    events = []
    for item in raw:
        try:
            when = datetime.fromisoformat(item["date"]).astimezone(timezone.utc)
        except (KeyError, ValueError, TypeError):
            continue
        events.append(NewsEvent(when, item.get("country", ""), item.get("title", ""), item.get("impact", "")))
    return events


async def _fetch() -> list[dict]:
    global _cache
    if _cache and _time.monotonic() - _cache[0] < _CACHE_TTL:
        return _cache[1]
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(FEED_URL, headers={"User-Agent": "smc-bot/1.0"})
        resp.raise_for_status()
        data = resp.json()
    _cache = (_time.monotonic(), data)
    return data


def high_impact_window(
    events: list[NewsEvent],
    now: datetime,
    currencies: set[str] | None,
    before: timedelta = timedelta(minutes=30),
    ahead: timedelta = timedelta(hours=4),
) -> list[NewsEvent]:
    """High-impact events from `before` ago until `ahead` from now."""
    return sorted(
        (
            e for e in events
            if e.impact == "High"
            and (currencies is None or e.country in currencies)
            and now - before <= e.when <= now + ahead
        ),
        key=lambda e: e.when,
    )


async def news_summary(symbol: str | None, now: datetime | None = None) -> tuple[str, bool]:
    """Returns (text for the prompt, danger) where danger = high-impact news within ±60 min."""
    now = now or datetime.now(timezone.utc)
    try:
        events = parse_events(await _fetch())
    except Exception as exc:  # network/feed problems must never block an analysis
        return (f"News check FAILED ({type(exc).__name__}). Trader must check Forex Factory manually.", False)

    upcoming = high_impact_window(events, now, symbol_currencies(symbol))
    if not upcoming:
        return ("No high-impact (red folder) news in the last 30 min or next 4 hours for this symbol.", False)

    danger = any(abs(e.when - now) <= timedelta(minutes=60) for e in upcoming)
    lines = ["High-impact (red folder) news near now:"]
    for e in upcoming:
        mins = int((e.when - now).total_seconds() // 60)
        rel = f"in {mins} min" if mins >= 0 else f"{-mins} min ago"
        lines.append(f"- {e.when:%H:%M} UTC ({rel}): {e.country} {e.title}")
    if danger:
        lines.append("WARNING: high-impact news within 60 minutes.")
    return ("\n".join(lines), danger)
