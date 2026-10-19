# Fan-out demo schemas

Two JSON Schemas (draft 2020-12) for the fan-out demo's driver (#4091) and its readers (behold). They follow the design in INTENTIUS/chant#4085, section 3.

| Schema | Written to | When |
|---|---|---|
| `demo-step.schema.json` (`demo-step/v1`) | `s3://chant-demo/fan-out-estate/step.json` | at every step of a cycle |
| `demo-cycle.schema.json` (`demo-cycle/v1`) | `cycles/latest.json` and `cycles/<cycle>.json`, newest five | at reset, full cycles only |

`index.ts` exports the types and `validateDemoStep` and `validateDemoCycle`. The driver validates every write with them.

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
| `next` | no | `{action, from, at}`: what the driver does after the hold. |
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

## Versioning

The contract is versioned like the workspace read contract. Within `contract: 1` a field is only ever added, and a new field is optional. Readers ignore fields they do not know, and a reader treats a step it does not know as one it cannot classify. The schema's `step` enum lists what a writer may write in this version; a new step is added to it within contract 1, so a reader never rejects a record for its step. A rename or removal is `contract: 2` with a new `$id` path (`v2`).
