# Drift-record adapter fixtures (#4451)

Hand-written, in the shapes `drift-record.test.ts` reads:

- `live-diff.json`: a `LiveDiffResult` (`chant lifecycle diff --live --json`), one entity in every bucket.
- `deep-diff.json`: a `DeepDiffResult`, with a changed path, an absent path, a path whose name looks secret-bearing, and a deep hole on an entity the thin read found.
- `component-status.json`: a `ComponentStatusResult` (`chant components status prod --live --json`), one row per reconciliation verdict, plus an `unknown` row that was never queried live.

None of them was recorded from a run.

`choudoufu-resource.ndjson` is written in the exact layout choudoufu's `live-plan -resource` emits
(`internal/command/views/live_drift.go` on choudoufu's `integration/choudoufu-engine`, H2): a `type` on
every line, bare expected addresses, the record's fields flat on its line, `node` null, attributes as
names with a sensitive flag, and a settle line with partial `counts` and an engine-specific `reads`
object. Hand-written from that writer's structs, not recorded from a run.
