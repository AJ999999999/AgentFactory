# How discounts stack

An invoice can carry several discounts. They combine like this, always:

1. Only the **largest percentage** discount applies; other percentage discounts are ignored.
2. The percentage comes off **before** any fixed discounts.
3. Fixed discounts (an amount in cents) **add up**.
4. The result is **never below zero**.
5. The percentage amount is rounded to whole cents, half to even (`docs/rules.md`).

A discount is `{ type: "percent", value: 10 }` or `{ type: "fixed", cents: 500 }`.
