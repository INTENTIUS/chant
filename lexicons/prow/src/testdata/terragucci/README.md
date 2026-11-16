These are the job configs terragucci's `runtime: prow` writes, copied as data from terragucci at 99d58b1. `renderProwJobs` in packages/terragucci/src/render-prow.ts wrote them, which is what `init-prow.ts` calls, for the inputs of terragucci's prow tests.

`default.yaml` holds the checks presubmit and the plan and apply postsubmits. `full.yaml` adds the plan presubmit and a drift periodic. Every job in it also names a namespace and links Deck. `config-repo.yaml` sets `config_repo`, which changes the header. The fixture test declares each one and compares the bytes it builds.
