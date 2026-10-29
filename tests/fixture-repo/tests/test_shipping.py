from shop.coupons import parse
from shop.shipping import Item, shipping_fee


def test_light_parcel():
    assert shipping_fee([Item(100, 0.5)], "Taipei") == 60


def test_bracket_limit_is_inclusive():
    assert shipping_fee([Item(100, 5)], "Taipei") == 120
    assert shipping_fee([Item(100, 20)], "Taipei") == 250


def test_every_started_kg_over_20():
    assert shipping_fee([Item(100, 20.5)], "Taipei") == 265
    assert shipping_fee([Item(100, 22)], "Taipei") == 280


def test_threshold_uses_the_discounted_subtotal():
    assert shipping_fee([Item(1250, 0.5)], "Taipei", parse("SAVE20")) == 0
    assert shipping_fee([Item(1200, 0.5)], "Taipei", parse("SAVE20")) == 60


def test_remote_region_never_gets_the_threshold_waiver():
    assert shipping_fee([Item(2000, 0.5)], "Penghu") == 160


def test_free_shipping_coupon_keeps_the_remote_surcharge():
    assert shipping_fee([Item(100, 0.5)], " kinmen ", parse("FREESHIP")) == 100


def test_fragile_surcharge_is_capped():
    assert shipping_fee([Item(10, 0.2, fragile=True)] * 4, "Taipei") == 150


def test_fragile_surcharge_applies_when_shipping_is_free():
    assert shipping_fee([Item(1500, 1, fragile=True)], "Taipei") == 30
