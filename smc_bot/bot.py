"""Telegram front-end: collect chart screenshots, then /analyze."""

import logging
from functools import wraps

from telegram import Update
from telegram.constants import ChatAction
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters

from .analyzer import Analyzer
from .config import Config, load_config
from .images import ChartImage, parse_timeframe, prepare_image
from .storage import Store

log = logging.getLogger(__name__)
TG_LIMIT = 4000

HELP = """\
📈 SMC / ICT Chart Analysis Bot

1) Ek hi pair ke charts ki screenshots bhejein (1m, 5m, 15m, 1H, 4H, 1D...).
   Har pic ke caption mein timeframe likhein, jaise: 1H  ya  4h  ya  5m
   Behtar quality ke liye pic ko "File" ke taur par bhejein.
2) /analyze likhein — bot structure, liquidity, POIs, premium/discount, LTF
   confirmation, session aur news dekh kar choti (1M) aur bari (swing) trade dega,
   RR aur lot size ke saath.

Settings:
/pair XAUUSD — instrument set karein
/balance 1000 — account balance
/risk 1 — risk % per trade (1-2% recommended)
/contract 100 — units per lot (auto: forex 100000, gold 100). "/contract auto" reset
/settings — current settings
/analyze <notes> — analysis (notes optional, e.g. "/analyze sirf long dekhna hai")
/clear — bheji hui pics delete karein
"""


def chunk(text: str, limit: int = TG_LIMIT) -> list[str]:
    parts, current = [], ""
    for line in text.splitlines(keepends=True):
        while len(line) > limit:
            if current:
                parts.append(current)
                current = ""
            parts.append(line[:limit])
            line = line[limit:]
        if len(current) + len(line) > limit:
            parts.append(current)
            current = ""
        current += line
    if current.strip():
        parts.append(current)
    return parts


class Bot:
    def __init__(self, config: Config):
        self.config = config
        self.store = Store(config.data_dir)
        self.analyzer = Analyzer(config.model, config.effort)

    def restricted(handler):
        @wraps(handler)
        async def wrapper(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
            allowed = self.config.allowed_user_ids
            user = update.effective_user
            if allowed and (user is None or user.id not in allowed):
                await update.effective_message.reply_text(
                    f"⛔ Aap ko is bot ki ijazat nahi. Aap ki user ID: {user.id if user else '?'}"
                )
                return
            return await handler(self, update, context)

        return wrapper

    @restricted
    async def start(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        await update.effective_message.reply_text(HELP)

    @restricted
    async def on_image(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        msg = update.effective_message
        chat_id = update.effective_chat.id
        charts = self.store.charts.setdefault(chat_id, [])
        if len(charts) >= self.config.max_images:
            await msg.reply_text(f"Maximum {self.config.max_images} pics. /analyze ya /clear karein.")
            return

        tg_file = await (msg.photo[-1] if msg.photo else msg.document).get_file()
        raw = bytes(await tg_file.download_as_bytearray())
        try:
            data, media_type = prepare_image(raw)
        except Exception:
            await msg.reply_text("❌ Yeh image read nahi ho saki. PNG/JPG bhejein.")
            return

        caption = msg.caption or ""
        tf = parse_timeframe(caption)
        charts.append(ChartImage(data, media_type, tf, caption))

        # One acknowledgement per album, not per photo
        group = msg.media_group_id
        if group and context.chat_data.get("last_group") == group:
            return
        context.chat_data["last_group"] = group
        tf_txt = tf or "timeframe nahi mila (caption mein likhein, warna bot chart se parhega)"
        await msg.reply_text(f"✅ Chart save: {tf_txt}. Total pics: {len(charts)}. Sab bhej kar /analyze likhein.")

    @restricted
    async def analyze(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        msg = update.effective_message
        chat_id = update.effective_chat.id
        charts = self.store.charts.get(chat_id) or []
        if not charts:
            await msg.reply_text("Pehle chart screenshots bhejein, phir /analyze.")
            return
        s = self.store.get(chat_id)
        tfs = ", ".join(c.timeframe or "?" for c in charts)
        await msg.reply_text(f"⏳ {len(charts)} charts ({tfs}) analyse ho rahe hain... 1-3 minute lag sakte hain.")
        await context.bot.send_chat_action(chat_id, ChatAction.TYPING)

        try:
            result = await self.analyzer.analyze(
                charts,
                symbol=s.symbol,
                balance=s.balance,
                risk_pct=s.risk_pct,
                contract_size=s.contract_size,
                notes=" ".join(context.args or []),
            )
        except Exception as exc:
            log.exception("analysis failed")
            await msg.reply_text(f"❌ Analysis fail ho gayi: {type(exc).__name__}: {exc}")
            return

        for part in chunk(result.text):
            await msg.reply_text(part)
        self.store.charts.pop(chat_id, None)
        await msg.reply_text("🧹 Pics clear kar di gayi hain. Agli analysis ke liye naye charts bhejein.")

    @restricted
    async def clear(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        self.store.charts.pop(update.effective_chat.id, None)
        await update.effective_message.reply_text("🧹 Sab pics delete.")

    @restricted
    async def settings(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        s = self.store.get(update.effective_chat.id)
        await update.effective_message.reply_text(
            f"Pair: {s.symbol or 'not set'}\nBalance: {s.balance:g}\nRisk: {s.risk_pct:g}%\n"
            f"Contract/lot: {s.contract_size or 'auto'}"
        )

    async def _set_number(self, update, context, field, lo, hi, label):
        try:
            value = float(context.args[0])
            if not lo <= value <= hi:
                raise ValueError
        except (IndexError, ValueError):
            await update.effective_message.reply_text(f"Sahi number dein ({lo:g} - {hi:g}).")
            return
        setattr(self.store.get(update.effective_chat.id), field, value)
        self.store.save()
        await update.effective_message.reply_text(f"✅ {label}: {value:g}")

    @restricted
    async def set_balance(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        await self._set_number(update, context, "balance", 1, 1e9, "Balance")

    @restricted
    async def set_risk(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        await self._set_number(update, context, "risk_pct", 0.1, 10, "Risk %")

    @restricted
    async def set_contract(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if context.args and context.args[0].lower() == "auto":
            self.store.get(update.effective_chat.id).contract_size = None
            self.store.save()
            await update.effective_message.reply_text("✅ Contract size: auto")
            return
        await self._set_number(update, context, "contract_size", 0.0001, 1e7, "Contract size")

    @restricted
    async def set_pair(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not context.args:
            await update.effective_message.reply_text("Example: /pair XAUUSD")
            return
        self.store.get(update.effective_chat.id).symbol = context.args[0].upper()
        self.store.save()
        await update.effective_message.reply_text(f"✅ Pair: {context.args[0].upper()}")

    def build(self) -> Application:
        app = Application.builder().token(self.config.telegram_token).concurrent_updates(True).build()
        app.add_handler(CommandHandler(["start", "help"], self.start))
        app.add_handler(CommandHandler("analyze", self.analyze))
        app.add_handler(CommandHandler("clear", self.clear))
        app.add_handler(CommandHandler("settings", self.settings))
        app.add_handler(CommandHandler("balance", self.set_balance))
        app.add_handler(CommandHandler("risk", self.set_risk))
        app.add_handler(CommandHandler("contract", self.set_contract))
        app.add_handler(CommandHandler("pair", self.set_pair))
        app.add_handler(MessageHandler(filters.PHOTO | filters.Document.IMAGE, self.on_image))
        return app


def main() -> None:
    logging.basicConfig(format="%(asctime)s %(levelname)s %(name)s: %(message)s", level=logging.INFO)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    Bot(load_config()).build().run_polling()


if __name__ == "__main__":
    main()
