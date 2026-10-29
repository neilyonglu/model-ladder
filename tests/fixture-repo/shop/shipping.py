import math
from dataclasses import dataclass

from shop import discount
from shop.coupons import Coupon

REMOTE_REGIONS = {"kinmen", "matsu", "penghu"}
FREE_THRESHOLD = 1000
REMOTE_SURCHARGE = 100
FRAGILE_FEE = 30
FRAGILE_CAP = 90


@dataclass(frozen=True)
class Item:
    price: float
    weight_kg: float
    fragile: bool = False


def base_fee(weight_kg: float) -> int:
    if weight_kg <= 1:
        return 60
    if weight_kg <= 5:
        return 120
    if weight_kg <= 20:
        return 250
    return 250 + 15 * math.ceil(weight_kg - 20)


def shipping_fee(items: list[Item], region: str, coupon: Coupon | None = None) -> int:
    """Shipping fee in whole NT$. Rules: docs/shipping.md"""
    weight = sum(item.weight_kg for item in items)
    subtotal = discount.apply(sum(item.price for item in items), coupon.percent if coupon else 0)
    remote = region.strip().lower() in REMOTE_REGIONS
    base = base_fee(weight)
    if coupon and coupon.free_shipping:
        base = 0
    elif subtotal >= FREE_THRESHOLD and not remote:
        base = 0
    surcharge = REMOTE_SURCHARGE if remote else 0
    fragile = min(FRAGILE_FEE * sum(item.fragile for item in items), FRAGILE_CAP)
    return math.ceil(base + surcharge + fragile)
