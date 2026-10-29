def restock(stock: dict[str, int], item: str, quantity: int) -> dict[str, int]:
    """Return a new stock dict with `quantity` more of `item`."""
    if quantity <= 0:
        raise ValueError("quantity must be positive")
    return {**stock, item: stock.get(item, 0) + quantity}
