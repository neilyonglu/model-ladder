from datetime import date

import pytest

from shop.coupons import is_valid, parse


def test_single_save():
    assert parse("SAVE20").percent == 20


def test_case_insensitive():
    coupon = parse("save10+freeship")
    assert coupon.percent == 10
    assert coupon.free_shipping


def test_save_parts_stack():
    assert parse("SAVE10+SAVE15").percent == 25


def test_stack_is_capped():
    assert parse("SAVE40+SAVE30").percent == 50


def test_expiry_day_is_still_valid():
    coupon = parse("FREESHIP|EXP2026-12-31")
    assert coupon.expires == date(2026, 12, 31)
    assert is_valid(coupon, date(2026, 12, 31))
    assert not is_valid(coupon, date(2027, 1, 1))


def test_unknown_part_is_rejected():
    with pytest.raises(ValueError):
        parse("BOGUS")


def test_expiry_needs_prefix():
    with pytest.raises(ValueError):
        parse("SAVE20|2026-12-31")
