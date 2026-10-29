MAX_PERCENT = 50


def apply(price: float, percent: float) -> float:
    """Take `percent` (0-100) off `price`, never more than MAX_PERCENT."""
    return price * (1 - min(percent, MAX_PERCENT) / 100)
