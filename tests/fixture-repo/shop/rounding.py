from decimal import ROUND_HALF_UP, Decimal


def round_price(amount: float) -> float:
    """Round to cents, halves away from zero, as a shopper expects."""
    return float(Decimal(str(amount)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
