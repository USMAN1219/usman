"""Run an analysis from local screenshots without Telegram.

    python -m smc_bot.cli 4h.png:4H 1h.png:1H 5m.png:5m 1m.png:1m --symbol XAUUSD --balance 1000 --risk 1
"""

import argparse
import asyncio
from pathlib import Path

from .analyzer import Analyzer
from .config import load_config
from .images import ChartImage, parse_timeframe, prepare_image


def main() -> None:
    p = argparse.ArgumentParser(description="SMC/ICT chart analysis from screenshots")
    p.add_argument("charts", nargs="+", help="image path, optionally with :TIMEFRAME (e.g. chart.png:1H)")
    p.add_argument("--symbol")
    p.add_argument("--balance", type=float, default=1000)
    p.add_argument("--risk", type=float, default=1)
    p.add_argument("--contract", type=float)
    p.add_argument("--notes", default="")
    args = p.parse_args()

    config = load_config(require_telegram=False)
    charts = []
    for spec in args.charts:
        path, _, tf = spec.partition(":") if not Path(spec).exists() else (spec, "", "")
        data, media_type = prepare_image(Path(path).read_bytes())
        charts.append(ChartImage(data, media_type, parse_timeframe(tf) or parse_timeframe(Path(path).stem)))

    result = asyncio.run(
        Analyzer(config.model, config.effort).analyze(
            charts,
            symbol=args.symbol,
            balance=args.balance,
            risk_pct=args.risk,
            contract_size=args.contract,
            notes=args.notes,
        )
    )
    print(result.text)


if __name__ == "__main__":
    main()
