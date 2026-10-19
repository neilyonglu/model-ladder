from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class Coupon:
    percent: int
    free_shipping: bool
    expires: date | None


def parse(code: str) -> Coupon:
    """Parse codes like 'SAVE20+FREESHIP|EXP2026-12-31'.

    Parts are joined by '+'. An optional '|EXPyyyy-mm-dd' suffix sets the last valid day.
    Matching is case-insensitive. Several SAVE parts add up, capped at 50.
    """
    body, _, expiry = code.strip().upper().partition("|")
    percent, free_shipping = 0, False
    for part in body.split("+"):
        if part.startswith("SAVE") and part[4:].isdigit():
            percent += int(part[4:])
        elif part == "FREESHIP":
            free_shipping = True
        else:
            raise ValueError(f"unknown coupon part: {part!r}")
    expires = None
    if expiry:
        if not expiry.startswith("EXP"):
            raise ValueError(f"bad expiry: {expiry!r}")
        expires = date.fromisoformat(expiry[3:])
    return Coupon(min(percent, 50), free_shipping, expires)


def is_valid(coupon: Coupon, today: date) -> bool:
    return coupon.expires is None or today <= coupon.expires
