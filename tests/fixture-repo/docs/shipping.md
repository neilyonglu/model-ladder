# Shipping fees

`shop.shipping.shipping_fee(items, region, coupon=None)` returns the shipping fee in whole NT$.

## Base fee by total weight

| Total weight | Base fee |
|---|---|
| up to 1 kg | 60 |
| up to 5 kg | 120 |
| up to 20 kg | 250 |
| over 20 kg | 250, plus 15 for every started kg above 20 |

"Up to" includes the limit: exactly 5 kg costs 120.

## Waiving the base fee

- A coupon with free shipping waives the base fee anywhere.
- Otherwise the base fee is waived when the cart subtotal, after the coupon's percent discount (`shop.discount.apply`), is at least 1000. This does not apply to remote regions.

## Surcharges

Surcharges are added even when the base fee is waived.

- Remote regions (Kinmen, Matsu, Penghu) pay 100. Region names are matched case-insensitively, ignoring surrounding spaces.
- Each fragile item adds 30, at most 90 per order.

## Rounding

The final fee is rounded up to a whole NT$.
