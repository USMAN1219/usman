import base64
import io
import re
from dataclasses import dataclass

from PIL import Image

MAX_BYTES = 4_500_000  # API limit is 5 MB per image after base64 decode
MAX_SIDE = 2400
_SUPPORTED = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp", "GIF": "image/gif"}

_TF_PATTERNS = [
    (r"\b(1|3|5|15|30|45)\s*(m|min|mins|minute|minutes)\b", "{}m"),
    (r"\b(1|2|3|4|6|8|12)\s*(h|hr|hrs|hour|hours)\b", "{}H"),
    (r"\b(1)?\s*(d|day|daily)\b", "1D"),
    (r"\b(1)?\s*(w|week|weekly)\b", "1W"),
    (r"\bm(1|3|5|15|30)\b", "{}m"),
    (r"\bh(1|4)\b", "{}H"),
]


@dataclass
class ChartImage:
    data: bytes
    media_type: str
    timeframe: str | None
    note: str = ""

    def to_block(self) -> dict:
        return {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": self.media_type,
                "data": base64.standard_b64encode(self.data).decode(),
            },
        }


def parse_timeframe(caption: str | None) -> str | None:
    if not caption:
        return None
    text = re.sub(r"[_\-.]", " ", caption.lower())
    for pattern, fmt in _TF_PATTERNS:
        m = re.search(pattern, text)
        if m:
            return fmt.format(m.group(1)) if "{}" in fmt else fmt
    return None


def prepare_image(raw: bytes) -> tuple[bytes, str]:
    """Return image bytes + media type acceptable to the API, re-encoding only if needed."""
    img = Image.open(io.BytesIO(raw))
    fmt = img.format or ""
    if fmt in _SUPPORTED and len(raw) <= MAX_BYTES and max(img.size) <= MAX_SIDE * 2:
        return raw, _SUPPORTED[fmt]
    img = img.convert("RGB")
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    quality = 92
    while True:
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=quality)
        if buf.tell() <= MAX_BYTES or quality <= 50:
            return buf.getvalue(), "image/jpeg"
        quality -= 10
