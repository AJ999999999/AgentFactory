# Money rules

- Amounts are whole cents everywhere inside the code. Text amounts may carry a `$`, thousands separators and at most two decimals: `12.34`, `-5`, `1,234.50`, `$3.10`.
- Every computed amount (tax, discounts, splits) is rounded to whole cents **half to even**: 0.5 → 0, 1.5 → 2, 2.5 → 2, -2.5 → -2, -3.5 → -4. Never round half up: the bank reconciles to the cent and half-up rounding drifts upward over thousands of invoices.
