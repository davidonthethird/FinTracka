# Private Apple receipt benchmark

The benchmark compares Apple Intelligence On-Device and Private Cloud Compute against manually reviewed receipt truth. One model is never used as truth for the other.

## Prepare private truth

```sh
./scripts/create-private-receipt-benchmark.sh
```

Place the private photos in `.private/receipt-benchmark/photos/`. Complete `truth.json` by reading the images yourself. Record exact merchant text, integer-cent total, purchased-item descriptions and integer-cent prices, and each photo's SHA-256. Do not commit or copy these files into logs.

The set should include Target, ACME, Lowe's, Stop & Shop, Home Depot, a screen photo, a faint/crumpled example, and a multi-page example.

## Run and review

1. Keep the production comparison flag off.
2. Enable comparison in staging for the two household members only.
3. Install the signed comparison Shortcut and launch it from the prepared FinTracka scan page.
4. Run every private example once. Record unavailable/rate-limited/failed as actual outcomes.
5. In FinTracka, compare both model cards with the original photo and choose the accurate route or **Neither**.
6. Export a private `receipt_benchmark_reviewed_results/v1` file containing only the manually reviewed result fields needed by the summarizer.
7. Run:

```sh
node scripts/summarize-receipt-benchmark.mjs \
  .private/receipt-benchmark/truth.json \
  .private/receipt-benchmark/reviewed-results.json
```

Choose a production route by merchant exactness, exact-cent total accuracy, line precision/recall, reconciliation rate, failure rate, and then latency. Zero dead-end scans and zero empty/duplicate drafts are required. If neither route is dependable, keep explicit manual review instead of declaring a winner.
