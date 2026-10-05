"""Trading session / ICT killzone detection.

Killzones are defined in New York time so they follow US daylight saving
automatically (London shifts with it closely enough for ICT usage).
"""

from dataclasses import dataclass
from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")

# (name, start, end, is_killzone) in New York local time
SESSIONS = [
    ("Asia Session", time(20, 0), time(0, 0), False),
    ("London Killzone", time(2, 0), time(5, 0), True),
    ("New York Killzone", time(7, 0), time(10, 0), True),
    ("London Close", time(10, 0), time(12, 0), False),
]


@dataclass
class SessionStatus:
    now_utc: datetime
    now_ny: datetime
    market_open: bool
    active: list[str]
    in_killzone: bool

    def describe(self) -> str:
        lines = [
            f"Current time: {self.now_utc:%Y-%m-%d %H:%M} UTC "
            f"({self.now_ny:%H:%M} New York, {self.now_ny:%A})",
        ]
        if not self.market_open:
            lines.append("Forex market is CLOSED (weekend).")
        elif self.active:
            lines.append("Active session(s): " + ", ".join(self.active))
        else:
            lines.append("No major session/killzone active right now (off-session).")
        lines.append("Inside a killzone: " + ("YES" if self.in_killzone else "NO"))
        return "\n".join(lines)


def _in_window(t: time, start: time, end: time) -> bool:
    if start < end:
        return start <= t < end
    return t >= start or t < end  # window wraps past midnight


def forex_market_open(now_ny: datetime) -> bool:
    """Forex runs Sunday 17:00 NY to Friday 17:00 NY."""
    wd, t = now_ny.weekday(), now_ny.time()  # Monday=0 ... Sunday=6
    if wd == 5:
        return False
    if wd == 4 and t >= time(17, 0):
        return False
    if wd == 6 and t < time(17, 0):
        return False
    return True


def session_status(now: datetime | None = None) -> SessionStatus:
    now_utc = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    now_ny = now_utc.astimezone(NY)
    t = now_ny.time()
    active = [name for name, s, e, _ in SESSIONS if _in_window(t, s, e)]
    in_kz = any(kz and _in_window(t, s, e) for _, s, e, kz in SESSIONS)
    is_open = forex_market_open(now_ny)
    return SessionStatus(now_utc, now_ny, is_open, active if is_open else [], in_kz and is_open)
