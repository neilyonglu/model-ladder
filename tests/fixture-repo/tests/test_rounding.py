from shop.rounding import round_price


def test_rounds_half_up():
    assert round_price(2.675) == 2.68


def test_rounds_down():
    assert round_price(1.234) == 1.23
