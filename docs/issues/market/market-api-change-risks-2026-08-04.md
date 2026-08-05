# Market API risk notes (August 2026)

## Issue 1 — Ambiguous `window` precedence between legacy `TradeOptions.window` and `TradeOptions.range.window`

### Summary
Recent trade-range API changes introduced `range` as the preferred windowing shape (`range.from`, `range.to`, `range.window`), but `resolvedTradeRange()` currently prefers `range.window` whenever both it and top-level `window` are present. This makes conflicting calls silently pick one branch instead of failing.

### Reproduction
1. Create two trades with known spacing so query windows diverge.
2. Call one trade-read API (for example `market.series`, `market.candles`, or `market.ticker`) with both:
   - `range: { window: '1m' }`
   - top-level `window: '1h'`
3. Validate output shape/coverage/count and compare to expected using only `window: '1h'`.

Example:

```ts
const withConflict = await market.series({
  from: [alice.address, bob.address],
  asset,
  window: '1h',
  range: { window: '1m' },
})
```

### Expected vs. actual
**Expected:** Conflicting declarations should error deterministically (`bad-duration`) or document a strict precedence rule (e.g., `range` always wins and top-level is rejected).

**Actual:** No error is thrown; `range.window` silently overrides the top-level `window` (`requested.window` is resolved from `range.window ?? window`).

### Impact
- **Correctness:** Callers can pass contradictory options from migration code and silently get a narrower/incorrect result.
- **API compatibility:** Mixed legacy/new callsites are now behavior-dependent without a clear contract, increasing production bugs when refactors only partially switch to `range`.
- **Diagnostics:** Harder triage for empty/partial charts because input validation is not explicit.

### Acceptance criteria
- Define and enforce a deterministic precedence contract for mixed `window` fields.
- Either:
  - reject mixed `window` usage with a typed error (`bad-duration`), or
  - preserve backward compatibility with an explicit, documented preference and warning behavior.
- Update API docs and type docs to mention the final contract.

### Proposed tests
- Add regression test:
  - `market.series({ window, range: { window } })` with conflicting values rejects (or returns contractually expected field).
- Add migration test:
  - same call path as existing API clients that still use top-level `window` continues to behave as documented.
- Add test coverage for `chart`, `candles`, and `ticker` for parity.

---

## Issue 2 — `market.chart().line` collapses points to second-resolution buckets, causing duplicate x values for sub-second trade density

### Summary
`market.chart()` now returns `line` for “chart renderer friendly” consumers, but this conversion uses `Math.floor(point.at / 1000)`. For dense trade sequences inside the same second, multiple rows collapse to the same `time` value and downstream chart libraries may overwrite earlier points.

### Reproduction
1. Create two accepted trades in the same second (e.g., advisory times `1700000001001` and `1700000001999`) for the same asset pair.
2. Fetch `chart()` with a narrow `range` and `every: '1s'`.
3. Compare `chart.line.length` with number of timed points returned by `chart.series.points.filter(p => p.at !== null).length`.

### Expected vs. actual
**Expected:** `line` preserves enough temporal resolution for renderer-safe x-values or intentionally documents that per-second normalization is lossy.

**Actual:** Different points in one second can map to identical `time`, so the payload technically keeps the rows but standard chart libraries treat them as duplicate x coordinates (one-point overwrite / draw artifact).

### Impact
- **Correctness:** Sub-second price movement and bursty trade activity is visually distorted in chart consumers using `chart.line`.
- **Consumer compatibility:** Existing integrations that expect 1:1 point mapping (for tooltips/markers/click handlers) may silently drop data.
- **Migration risk:** This is newly introduced by the market-level `line` payload; existing code consuming `InstrumentApi`’s `toUnixLine` may now assume similar semantics unexpectedly.

### Acceptance criteria
- Decide one explicit behavior for sub-second trades:
  - keep seconds (`time` as `ms`) and update docs, or
  - de-duplicate deterministically (e.g., preserve order or encode sequence).
- Add a dedicated test for collisions:
  - create two trades in one second and assert `chart.line` includes both (or assert documented lossy behavior).
- Add a quick compatibility test that validates a round-trip with a charting consumer contract (at least array length and first/last values).
