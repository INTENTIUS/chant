# Drift-record fixtures (#4451)

`live-plan-sections.json` is hand-written in the shape of choudoufu's `live-plan -json`
(`internal/command/views/live_plan.go`, `LivePlanDocument`) to cover what the recorded
`../live-plan.json` does not: `foreign[]`, `controller_held[]`, the omission reasons
`VERIFIED_NOT_IMPORTABLE` and `OUT_OF_SCOPE`, an `UNOWNED` omission with no `unowned[]` row,
a credentials failure, an omission code chant does not know, and `record` and `cache` bound sources.
It was not recorded from a run.

`drift-record.test.ts` also reads the recorded fixtures one directory up: `live-plan.json`,
`live-ls.json`, `show-state.json`, `show-plan.json` and `live-plan-depth/`.

`../drift-rows/` holds two hand-written plans for `drift-rows.test.ts` (#4580), also not recorded
from a run: `refresh-plan.json`, a stock root's refresh-only plan whose `resource_drift` has an update,
a delete, a create and a data row, and `live-root-plan.json`, a full plan of a root under live resource
markers with a create, a delete, an update, both replacement orders, a no-op and two data rows.
