"""Per-chat settings, persisted as JSON. Chart images are kept in memory only."""

import json
from dataclasses import asdict, dataclass
from pathlib import Path

from .images import ChartImage


@dataclass
class ChatSettings:
    symbol: str | None = None
    balance: float = 1000.0
    risk_pct: float = 1.0
    contract_size: float | None = None


class Store:
    def __init__(self, data_dir: Path):
        self.path = data_dir / "settings.json"
        self.settings: dict[int, ChatSettings] = {}
        self.charts: dict[int, list[ChartImage]] = {}
        if self.path.exists():
            raw = json.loads(self.path.read_text())
            self.settings = {int(k): ChatSettings(**v) for k, v in raw.items()}

    def get(self, chat_id: int) -> ChatSettings:
        return self.settings.setdefault(chat_id, ChatSettings())

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({k: asdict(v) for k, v in self.settings.items()}, indent=2))
