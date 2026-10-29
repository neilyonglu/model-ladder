from shop import discount
from shop.rounding import round_price


def total(prices: list[float], coupon_percent: float = 0) -> float:
    subtotal = sum(prices)
    return round_price(discount.apply(subtotal, coupon_percent))
