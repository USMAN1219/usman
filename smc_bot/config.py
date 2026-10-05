import os
from dataclasses import dataclass, field
from pathlib import Path


def _load_dotenv(path: Path = Path(".env")) -> None:
    """Minimal .env loader so the bot runs without extra dependencies."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


@dataclass(frozen=True)
class Config:
    telegram_token: str
    model: str = "claude-opus-5-5"
    effort: str = "high"
    data_dir: Path = Path("data")
    allowed_user_ids: frozenset[int] = field(default_factory=frozenset)
    max_images: int = 20


def load_config(require_telegram: bool = True) -> Config:
    _load_dotenv()
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if require_telegram and not token:
        raise SystemExit("TELEGRAM_BOT_TOKEN set nahi hai (.env file dekhein).")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("ANTHROPIC_API_KEY set nahi hai (.env file dekhein).")
    allowed = frozenset(
        int(x) for x in os.environ.get("ALLOWED_USER_IDS", "").replace(" ", "").split(",") if x
    )
    return Config(
        telegram_token=token,
        model=os.environ.get("CLAUDE_MODEL", "claude-opus-5-5"),
        effort=os.environ.get("CLAUDE_EFFORT", "high"),
        data_dir=Path(os.environ.get("DATA_DIR", "data")),
        allowed_user_ids=allowed,
    )
