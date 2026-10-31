# Using tally

Run tally from the project folder with Node: `tally` below stands for `node src/cli.js`.

## total

The net total of every transaction in the file.

```
tally total data/transactions.csv
```

prints

```
1657.42
```

## report

Totals per category, sorted by name, then the overall total.

```
tally report data/transactions.csv
```

prints

```
education: -62.15
gifts: -45.00
groceries: -102.23
housing: -4350.00
income: 6400.00
transport: -128.00
utilities: -55.20
total: 1657.42
```

## list

Lists the transactions a page at a time: `--page` (from 1, default 1) and `--size` (default 10).

```
tally list data/transactions.csv
tally list data/transactions.csv --page 2 --size 5
```

The second prints the sixth to tenth transactions, then `page 2 of 3`.
