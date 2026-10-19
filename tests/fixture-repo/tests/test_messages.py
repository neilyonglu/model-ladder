from shop.messages import welcome


def test_welcome():
    assert welcome("Ana") == "Welcome to the shop, Ana!"
