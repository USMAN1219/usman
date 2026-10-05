"""Risk-reward and position sizing, computed in code (never left to the model)."""

from dataclasses import dataclass

# Units of the base asset per 1 standard lot. Broker-dependent for indices/crypto.
_CONTRACT_SIZES = [
    ("XAU", 100), ("GOLD", 100), ("XAG", 5000), ("SILVER", 5000),
    ("BTC", 1), ("ETH", 1),
    ("US30", 1), ("NAS", 1), ("US100", 1), ("SPX", 1), ("US500", 1),
    ("GER40", 1), ("DE40", 1), ("UK100", 1), ("JP225", 1),
    ("WTI", 1000), ("USOIL", 1000),
]
FOREX_LOT = 100_000


def default_contract_size(symbol: str | None) -> float | None:
    if not symbol:
        return None
    s = symbol.upper().replace("/", "").replace("_", "")
    for prefix, size in _CONTRACT_SIZES:
        if s.startswith(prefix):
            return size
    if len(s) == 6 and s.isalpha():
        return FOREX_LOT
    return None


def quote_is_usd(symbol: str | None) -> bool:
    """Lot math below is exact only when P/L is in USD (e.g. EURUSD, XAUUSD, US indices)."""
    if not symbol:
        return False
    s = symbol.upper().replace("/", "")
    if len(s) == 6 and s.isalpha():
        return s.endswith("USD")
    return True  # metals, crypto and US indices quoted in USD


@dataclass
class TradeLevels:
    direction: str  # "long" | "short"
    entry: float
    stop_loss: float
    take_profits: list[float]


@dataclass
class SizedTrade:
    risk_amount: float
    stop_distance: float
    rr: list[float]
    lots: float | None
    units: float
    errors: list[str]


def validate_levels(t: TradeLevels) -> list[str]:
    errors = []
    if t.direction == "long":
        if t.stop_loss >= t.entry:
            errors.append("Long trade mein SL entry se neeche hona chahiye.")
        if any(tp <= t.entry for tp in t.take_profits):
            errors.append("Long trade mein har TP entry se upar hona chahiye.")
    elif t.direction == "short":
        if t.stop_loss <= t.entry:
            errors.append("Short trade mein SL entry se upar hona chahiye.")
        if any(tp >= t.entry for tp in t.take_profits):
            errors.append("Short trade mein har TP entry se neeche hona chahiye.")
    else:
        errors.append(f"Unknown direction: {t.direction}")
    return errors


def size_trade(
    t: TradeLevels, balance: float, risk_pct: float, contract_size: float | None
) -> SizedTrade:
    errors = validate_levels(t)
    stop = abs(t.entry - t.stop_loss)
    risk_amount = balance * risk_pct / 100
    if stop == 0:
        return SizedTrade(risk_amount, 0, [], None, 0, errors + ["SL aur entry same hain."])
    rr = [round(abs(tp - t.entry) / stop, 2) for tp in t.take_profits]
    units = risk_amount / stop
    lots = units / contract_size if contract_size else None
    return SizedTrade(risk_amount, stop, rr, lots, units, errors)
