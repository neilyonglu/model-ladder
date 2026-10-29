from shop.pricing import total


def test_total_without_coupon():
    assert total([10.0, 5.5]) == 15.5


def test_total_with_coupon():
    assert total([100.0], coupon_percent=20) == 80.0


def test_coupon_is_capped_at_half():
    assert total([100.0], coupon_percent=80) == 50.0
