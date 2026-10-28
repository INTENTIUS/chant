# e2e harness schemas

JSON Schemas (draft 2020-12) of the e2e harness (chant#4587). `index.ts` exports their types and validators. The two demo schemas came from `examples/fan-out-estate/demo/schemas/`, where the fan-out demo's driver (#4091) and its readers (behold) use them; their design is INTENTIUS/chant#4085, section 3.

| Schema | Written to | When |
|---|---|---|
| `demo-step.schema.json` (`demo-step/v1`) | a demo's `step.json`, such as `s3://chant-demo/fan-out-estate/step.json` | at every step of a cycle |
| `demo-cycle.schema.json` (`demo-cycle/v1`) | `cycles/latest.json` and `cycles/<cycle>.json`, newest five | at reset, full cycles only |
| `e2e-scenario.schema.json` (`e2e-scenario/v1`) | a product's scenario files | by hand; `lintScenario` checks them |
| `e2e-claim-row.schema.json` (`e2e-claim-row/v1`) | the `claim` outcome of an `e2e-claim` run record on the ledger (#4551) | once per claim run, after a CLEAN scan |
| `e2e-claims.schema.json` (`e2e-claims/v1`) | the file a product's page reads | rendered from the ledger by `renderClaims` |

## demo-step/v1

| Field | Required | Meaning |
|---|---|---|
| `$schema` | yes | The schema's `$id`. |
| `contract` | yes | `1`. |
| `demo` | yes | `fan-out-estate`. |
| `cycle` | yes | Cycle number. |
| `step` | yes | One of pull-request, planned, waiting, approved, merged, applying, failed, resumed, applied, reset, stalled. |
| `repo` | no | Forge repository, `chant-demo/fan-out-estate`. |
| `scenario`, `name`, `title`, `label` | no | Scenario id, display name, story title, one line narrating the step. |
| `highlight` | no | `{title, body}` or null: a call-out a viewer may show as a modal at the step that earns one. Cycle step items carry it too. |
| `chapter` | no | `{n, of, headline, short}` or null. Null only on the base and on a stall before the first step. |
| `started_at`, `at` | no | When the cycle started and when this step was written. |
| `next` | no | `{action, from, at}`: the driver's next action after the hold. |
| `pull`, `commit` | no | Pull request number and the commit the step concerns. |
| `reports` | no | `{url, plan?, apply?}`. `plan` and `apply` are `reportKey(pr, commit)` keys (`<pr>/<commit>`) below `url`. |
| `about` | no | `{changes, watch, shows}` cards. |

## demo-cycle/v1

| Field | Required | Meaning |
|---|---|---|
| `$schema`, `contract`, `demo`, `cycle` | yes | As above. |
| `steps` | yes | The step records as written, each with `at`. `step` and `at` are required in each. |
| `repo`, `started`, `ended` | no | Repository and the cycle's start and end. |
| `reports` | no | `[{stage, pr, commit, key}]`, stage `plan` or `apply`, `key` from `reportKey(pr, commit)`. |

## e2e-scenario/v1

| Field | Required | Meaning |
|---|---|---|
| `$schema`, `contract` | yes | The schema's `$id`, and `1`. |
| `id`, `product`, `claim` | yes | The scenario id, the product that drives it, and the claim id its row records. |
| `tree` | yes | `{base, overlays?}`: the repo the forge serves and the overlays steps copy over it, relative to the file. |
| `reportUrl` | yes | The pipeline's `--report-url`, `s3://<bucket>/<prefix>`. |
| `env` | no | The chant environment the ledger records runs under. Default `local`. |
| `limits` | no | Seconds per kind of step, over the defaults in `steps.ts`. |
| `steps` | yes | In order. `do` is open, open-concurrent, plan, approve, merge, apply, out-of-band or kill-job; each may carry `expect`. |
| `break` | yes | The BREAK arm: `env` with `BREAK: "1"`, and an optional `overlay` copied over every pull request of the break run. |

An outcome in `expect` has one key: `report` (`status`, `components`, `only`) on a plan or apply step, `ledger` (`op`, `status`, `count`), `comment`, `issue` (`title`, `open`), or `exit` on an out-of-band step.

## e2e-claim-row/v1 and e2e-claims/v1

A row carries `product`, `productCommit` (40 hex), `scenario`, `claim`, `engine` (`binary`, `version`), `floci` (`sha256:` digest), `date` (`YYYY-MM-DD`), `plain` (`pass` or `fail`), `break` (`caught`, `missed` or `stalled`) and `safeRun`, which is always `CLEAN`. `chant` and `runUrl` are optional. e2e-claims/v1 is `{product, rows}`, the newest row per scenario and claim.

## Versioning

Each contract is versioned like the workspace read contract. Within `contract: 1` a field is only ever added, and a new field is optional. Readers ignore fields they do not know, and a reader treats a step it does not know as one it cannot classify. The `step` enum of demo-step lists what a writer may write in this version; a new step is added to it within contract 1, so a reader never rejects a record for its step. A rename or removal is `contract: 2` with a new `$id` path (`v2`).
