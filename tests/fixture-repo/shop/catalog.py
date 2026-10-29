from functools import lru_cache

_PRICES = {"apple": 30.0, "tea": 120.0, "mug": 250.0}


@lru_cache(maxsize=None)
def product(sku: str) -> dict:
    """Catalog lookup. Cached: callers must not mutate the returned dict."""
    return {"sku": sku, "price": _PRICES[sku]}
