# Drift-record fixtures (#4451)

`live-plan-sections.json` is hand-written in the shape of choudoufu's `live-plan -json`
(`internal/command/views/live_plan.go`, `LivePlanDocument`) to cover what the recorded
`../live-plan.json` does not: `foreign[]`, `controller_held[]`, the omission reasons
`VERIFIED_NOT_IMPORTABLE` and `OUT_OF_SCOPE`, an `UNOWNED` omission with no `unowned[]` row,
a credentials failure, an omission code chant does not know, and `record` and `cache` bound sources.
It was not recorded from a run.

`drift-record.test.ts` also reads the recorded fixtures one directory up: `live-plan.json`,
`live-ls.json`, `show-state.json`, `show-plan.json` and `live-plan-depth/`.
