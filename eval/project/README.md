# tally

Small bookkeeping tools for one household's money: amounts in cents, invoices with tax and discounts, and reports over a CSV of transactions.

```
node src/cli.js total  data/transactions.csv
node src/cli.js report data/transactions.csv
node src/cli.js list   data/transactions.csv --page 1 --size 5
npm test
```

- `src/money.js`: amounts as whole cents; parsing, formatting and rounding (see `docs/rules.md`)
- `src/invoice.js`, `src/tax.js`, `src/discount.js`: invoice totals (see `docs/discounts.md` and `docs/vendor/`)
- `src/csv.js`, `src/loader.js`, `src/budget.js`: reading data files
- `src/report.js`, `src/paginate.js`, `src/cli.js`: reports and the command line
- `src/rules.js`: evaluates discount rules from client config files
