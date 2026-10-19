from shop import catalog
from shop.pricing import total

MEMBER_RATE = 0.9


def checkout(skus: list[str], member: bool = False) -> float:
    prices = []
    for sku in skus:
        line = dict(catalog.product(sku))
        if member:
            line["price"] = line["price"] * MEMBER_RATE
        prices.append(line["price"])
    return total(prices)
