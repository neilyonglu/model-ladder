from shop.cart import checkout


def test_regular_checkout():
    assert checkout(["apple", "tea"]) == 150.0


def test_member_discount():
    assert checkout(["tea"], member=True) == 108.0


def test_member_checkout_is_repeatable():
    first = checkout(["tea", "mug"], member=True)
    second = checkout(["tea", "mug"], member=True)
    assert first == second == 333.0


def test_member_checkout_leaves_regular_prices_alone():
    checkout(["mug"], member=True)
    assert checkout(["mug"]) == 250.0
