from datetime import datetime, timedelta, timezone

from smc_bot.analyzer import money_management, split_trade_json
from smc_bot.bot import chunk
from smc_bot.images import parse_timeframe, prepare_image
from smc_bot.news import NewsEvent, high_impact_window, parse_events, symbol_currencies
from smc_bot.risk import TradeLevels, default_contract_size, size_trade
from smc_bot.sessions import session_status


def test_parse_timeframe():
    assert parse_timeframe("1H") == "1H"
    assert parse_timeframe("gold 4h chart") == "4H"
    assert parse_timeframe("15m") == "15m"
    assert parse_timeframe("1 min") == "1m"
    assert parse_timeframe("M5") == "5m"
    assert parse_timeframe("Daily") == "1D"
    assert parse_timeframe("xauusd_1h") == "1H"
    assert parse_timeframe("gold") is None
    assert parse_timeframe(None) is None


def test_size_trade_gold_long():
    t = TradeLevels("long", 2340.0, 2336.0, [2348.0, 2352.0])
    s = size_trade(t, balance=1000, risk_pct=1, contract_size=100)
    assert s.errors == []
    assert s.rr == [2.0, 3.0]
    assert s.risk_amount == 10
    assert round(s.lots, 4) == 0.025  # $10 / ($4 * 100 oz)


def test_size_trade_eurusd_short_and_validation():
    s = size_trade(TradeLevels("short", 1.0850, 1.0870, [1.0790]), 5000, 1, 100_000)
    assert s.rr == [3.0]
    assert round(s.lots, 2) == 0.25  # $50 / (0.0020 * 100000)
    bad = size_trade(TradeLevels("short", 1.0850, 1.0830, [1.0900]), 5000, 1, 100_000)
    assert len(bad.errors) == 2


def test_contract_and_currencies():
    assert default_contract_size("XAUUSD") == 100
    assert default_contract_size("EUR/USD") == 100_000
    assert default_contract_size("XYZ") is None
    assert symbol_currencies("GBPJPY") == {"GBP", "JPY"}
    assert symbol_currencies("XAUUSD") == {"USD"}
    assert symbol_currencies(None) is None


def test_news_window():
    now = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)
    raw = [
        {"title": "Non-Farm Employment Change", "country": "USD", "date": "2026-10-02T08:30:00-04:00", "impact": "High"},
        {"title": "German PMI", "country": "EUR", "date": "2026-10-02T09:00:00+02:00", "impact": "High"},
        {"title": "Minor", "country": "USD", "date": "2026-10-02T08:45:00-04:00", "impact": "Low"},
        {"title": "broken", "country": "USD", "date": "nope", "impact": "High"},
    ]
    events = parse_events(raw)
    assert len(events) == 3
    hits = high_impact_window(events, now, {"USD"})
    assert [e.title for e in hits] == ["Non-Farm Employment Change"]


def test_sessions():
    # 13:00 UTC Wednesday in summer = 09:00 New York -> NY killzone
    s = session_status(datetime(2026, 7, 15, 13, 0, tzinfo=timezone.utc))
    assert s.in_killzone and "New York Killzone" in s.active
    # Saturday -> closed
    s = session_status(datetime(2026, 7, 18, 13, 0, tzinfo=timezone.utc))
    assert not s.market_open and not s.in_killzone
    # 02:00 UTC Wednesday in summer = 22:00 NY Tuesday -> Asia, not killzone
    s = session_status(datetime(2026, 7, 15, 2, 0, tzinfo=timezone.utc))
    assert s.active == ["Asia Session"] and not s.in_killzone


def test_split_trade_json_and_money_management():
    text = """analysis here
<trade_json>
{"symbol": "XAUUSD", "htf_bias": "bullish",
 "scalp": {"direction": "long", "entry": 2340, "stop_loss": 2336, "take_profits": [2352]},
 "swing": {"direction": "none", "entry": null, "stop_loss": null, "take_profits": []}}
</trade_json>"""
    clean, trade = split_trade_json(text)
    assert clean == "analysis here"
    assert trade["scalp"]["entry"] == 2340
    mm = money_management(trade, symbol=None, balance=1000, risk_pct=1, contract_size=None,
                          in_killzone=True, news_danger=False)
    assert "1:3" in mm and "0.02 lots" in mm and "Bari Trade: koi valid trade nahi" in mm
    assert split_trade_json("no block") == ("no block", None)


def test_chunk():
    text = "\n".join("x" * 100 for _ in range(100))
    parts = chunk(text, 1000)
    assert all(len(p) <= 1000 for p in parts)
    assert "".join(parts) == text


def test_prepare_image_reencodes_large(tmp_path):
    from PIL import Image
    import io
    img = Image.effect_noise((6000, 6000), 100).convert("RGB")
    buf = io.BytesIO(); img.save(buf, "PNG")
    data, media = prepare_image(buf.getvalue())
    assert media == "image/jpeg" and len(data) <= 4_500_000
