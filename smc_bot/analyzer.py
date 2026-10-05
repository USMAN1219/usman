import json
import math
import re
from dataclasses import dataclass

import anthropic

from .images import ChartImage
from .news import news_summary
from .prompts import SYSTEM_PROMPT, build_context
from .risk import TradeLevels, default_contract_size, quote_is_usd, size_trade
from .sessions import session_status

_TRADE_JSON = re.compile(r"<trade_json>\s*(.*?)\s*</trade_json>", re.S)


@dataclass
class AnalysisResult:
    text: str
    trade: dict | None


def split_trade_json(text: str) -> tuple[str, dict | None]:
    """Remove the <trade_json> block from the model text and parse it."""
    m = _TRADE_JSON.search(text)
    if not m:
        return text.strip(), None
    clean = (text[: m.start()] + text[m.end():]).strip()
    raw = m.group(1).strip().removeprefix("```json").removeprefix("```").removesuffix("```")
    try:
        return clean, json.loads(raw)
    except json.JSONDecodeError:
        return clean, None


def _num(x) -> float | None:
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _fmt(x: float) -> str:
    return f"{x:,.5f}".rstrip("0").rstrip(".") if abs(x) < 10 else f"{x:,.2f}"


def money_management(
    trade: dict | None,
    *,
    symbol: str | None,
    balance: float,
    risk_pct: float,
    contract_size: float | None,
    in_killzone: bool,
    news_danger: bool,
) -> str:
    symbol = symbol or (trade or {}).get("symbol")
    contract = contract_size or default_contract_size(symbol)
    lines = [f"💰 Money Management (balance {balance:g}, risk {risk_pct:g}%)"]
    if risk_pct > 2:
        lines.append(f"⚠️ {risk_pct:g}% risk zyada hai — pro traders 1-2% se upar nahi jaate.")
    if trade is None:
        lines.append("Trade levels parse nahi ho sake, lot size khud calculate karein.")
        return "\n".join(lines)

    for key, label in (("scalp", "🎯 Choti Trade"), ("swing", "🏔️ Bari Trade")):
        leg = trade.get(key) or {}
        entry, sl = _num(leg.get("entry")), _num(leg.get("stop_loss"))
        tps = [v for v in (_num(t) for t in leg.get("take_profits") or []) if v is not None]
        if leg.get("direction") not in ("long", "short") or entry is None or sl is None or not tps:
            lines.append(f"{label}: koi valid trade nahi (wait karein).")
            continue
        sized = size_trade(TradeLevels(leg["direction"], entry, sl, tps), balance, risk_pct, contract)
        lines.append(f"{label}: {leg['direction'].upper()} @ {_fmt(entry)} | SL {_fmt(sl)}")
        for err in sized.errors:
            lines.append(f"   ❌ {err}")
        if not sized.rr:
            continue
        rr_txt = ", ".join(f"TP{i + 1} {_fmt(tp)} = 1:{rr:g}" for i, (tp, rr) in enumerate(zip(tps, sized.rr)))
        lines.append(f"   RR: {rr_txt}")
        if max(sized.rr) < 3:
            lines.append("   ⚠️ Final target 1:3 se kam hai — checklist ke hisaab se yeh trade skip karein.")
        lines.append(f"   Risk amount: {sized.risk_amount:,.2f} | SL distance: {_fmt(sized.stop_distance)}")
        if sized.lots is not None:
            approx = "" if quote_is_usd(symbol) else " (approx — quote currency USD nahi hai, broker calculator se confirm karein)"
            lots = math.floor(sized.lots * 100 + 1e-9) / 100  # round down so risk never exceeds the limit
            if lots < 0.01:
                lines.append(f"   ⚠️ Minimum 0.01 lot bhi {risk_pct:g}% risk se zyada hai — SL bara hai ya balance kam.")
            else:
                lines.append(f"   Lot size: {lots:.2f} lots (contract {contract:g}/lot){approx}")
        else:
            lines.append(f"   Position: {sized.units:,.4f} units (lot size ke liye /contract set karein)")

    if not in_killzone:
        lines.append("⏰ Abhi London/NY killzone nahi hai — off-session trade avoid karein ya killzone ka wait karein.")
    if news_danger:
        lines.append("📰 60 min ke andar high-impact news hai — news ke baad entry lein.")
    lines.append("ℹ️ Levels screenshot se parhe gaye hain; entry se pehle live chart par confirm karein. Yeh financial advice nahi hai.")
    return "\n".join(lines)


class Analyzer:
    def __init__(self, model: str = "claude-opus-5-5", effort: str = "high"):
        self.client = anthropic.AsyncAnthropic()
        self.model = model
        self.effort = effort

    async def analyze(
        self,
        charts: list[ChartImage],
        *,
        symbol: str | None,
        balance: float,
        risk_pct: float,
        contract_size: float | None = None,
        notes: str = "",
    ) -> AnalysisResult:
        status = session_status()
        news_text, news_danger = await news_summary(symbol)

        content: list[dict] = []
        for i, chart in enumerate(charts, 1):
            label = chart.timeframe or "unknown (read it from the chart)"
            extra = f" — trader note: {chart.note}" if chart.note else ""
            content.append({"type": "text", "text": f"Chart {i} — timeframe: {label}{extra}"})
            content.append(chart.to_block())
        content.append({
            "type": "text",
            "text": build_context(
                symbol=symbol,
                session_text=status.describe(),
                news_text=news_text,
                balance=balance,
                risk_pct=risk_pct,
                notes=notes,
            ),
        })

        async with self.client.beta.messages.stream(
            model=self.model,
            max_tokens=64000,
            system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": content}],
            thinking={"type": "adaptive"},
            output_config={"effort": self.effort},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        ) as stream:
            message = await stream.get_final_message()

        if message.stop_reason == "refusal":
            return AnalysisResult("❌ Model ne yeh request decline kar di. Dobara koshish karein.", None)

        text = "".join(b.text for b in message.content if b.type == "text")
        if message.stop_reason == "max_tokens":
            text += "\n\n(⚠️ Jawab lamba ho kar kat gaya.)"
        clean, trade = split_trade_json(text)
        mm = money_management(
            trade,
            symbol=symbol,
            balance=balance,
            risk_pct=risk_pct,
            contract_size=contract_size,
            in_killzone=status.in_killzone,
            news_danger=news_danger,
        )
        return AnalysisResult(f"{clean}\n\n{mm}", trade)
