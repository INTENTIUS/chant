# @intentius/chant-lexicon-pulumi

Pulumi lexicon for [chant](https://intentius.io/chant/). It adds your Pulumi program to a chant workspace as it is, on stock Pulumi or on [plunge](https://github.com/INTENTIUS/plunge), a Pulumi fork that keeps chant's ownership markers on each resource. It declares no resource types. It supplies the `pulumi` workspace member kind and reads a Pulumi program four ways:

| Read | Source | Module |
|---|---|---|
| the member's graph | the `pulumi stack export` the last `pulumi-up` apply wrote to `refs/chant/snapshots`, else the one checked in as `stack-export.json` | `src/workspace-member.ts`, `src/stack-export-snapshot.ts` |
| its change-set part | `pulumi preview --json` | `src/change-set.ts` |
| its drift records | `pulumi refresh --preview-only --json --target <urn>`, one resource at a time | `src/drift-record.ts`, `src/drift-read.ts` |
| its stack outputs, for another member's parameters | `pulumi stack output --json --show-secrets=false` (applied) and `pulumi preview --json` (planned) | `src/stack-outputs.ts`, `src/member-outputs.ts` |
| engine facts, for a member on plunge | `plunge graph --json --stack <stack>` (`describeResources`), or the checked-in `engine-graph.json` (the graph read) | `src/describe-resources.ts`, `src/engine-graph.ts` |

The graph read never runs `pulumi`. The change set and drift run `preview` and `refresh --preview-only`, and the outputs read adds `stack output --json --show-secrets=false`. A member on plunge runs `plunge preview`, `plunge stack output --json --show-secrets=false` and `plunge drift --resource <urn> --stream`. For its engine facts it runs one of exactly four argv: `plunge graph --json`, `plunge graph --json --stack <stack>`, `plunge graph --json --versions` and `plunge graph --json --stack <stack> --versions` ([#4529](https://github.com/INTENTIUS/chant/issues/4529)). An outputs or secrets flag on `plunge graph` is refused. That is the whole list, as ruled on [#4476](https://github.com/INTENTIUS/chant/issues/4476) (2026-10-25), which widened the [#4450](https://github.com/INTENTIUS/chant/issues/4450) ruling's `preview` and `refresh --preview-only` to keep the outputs read and the plunge commands. Nothing else runs on a read (`runAllowedPulumi` and `runAllowedPlunge` refuse any other argv, and a preview with `--show-secrets` or `--import-file`), so no read changes a stack. With `CHANT_PULUMI_APPLIED_OUTPUTS=export`, the outputs read runs nothing either.

## Applies: the `pulumi-up` capability

A stack can be a component step, `{ kind: "pulumi-up", dir, stack }`, that plans in a pull request and applies on merge like a `terraform-apply` root ([#4541](https://github.com/INTENTIUS/chant/issues/4541), `src/pulumi-up.ts`). The ruling on INTENTIUS/plywood#1 widened #4450 and #4476 for it alone, from an apply job holding the apply identity. Its `up` goes through `runApplyPulumi` or `runApplyPlunge`, each of which takes one fixed argv (`PULUMI_APPLY_COMMANDS` in `src/run.ts`):

| Engine | Argv |
|---|---|
| plunge | `plunge preview --json --show-sames --stack <s> --save-plan <file>`, then `plunge up --plan <file> --yes --json --stack <s>` |
| stock Pulumi | `pulumi preview --json --show-sames --stack <s>`, then `pulumi up --yes --json --stack <s>` |

Both forms may add `--config-file <file>`, then `--target <urn>` for each target, then `--policy-pack <dir>` with an optional `--policy-pack-config <file>`, in that order. Any other flag on `up` is refused.

A step pinned to its own engine release sets `engineVersion` (and `engineRoot` when its image keeps engines elsewhere than `/opt/chant`). Every run of that step, preview, `up`, stack output and export, then uses `<engineRoot>/<engine>-<engineVersion>/<engine>`, the path `pulumiInstallLine` and `plungeInstallLine` install to ([#4592](https://github.com/INTENTIUS/chant/issues/4592), `src/ci-setup.ts`). The argv is checked against the same forms, and a step without `engineVersion` runs the binary on PATH.

The CI install lines take a version, download the release's Linux archive and its checksums file, and fail unless the archive matches its line there. For the default releases (Pulumi 3.272.0, plunge 0.1.0) the line must also hold the sha256 the lexicon records per architecture. Each release goes under its own versioned directory and is linked into `/usr/local/bin`, and a line skips the download when that directory already holds the binary, or for Pulumi when the `pulumi` on PATH is that version.

The preview streams its engine events (`PULUMI_ENABLE_STREAMING_JSON_PREVIEW=true`, `src/engine-events.ts`), so one run gives the change set and CrossGuard's findings. A mandatory violation denies the plan. On plunge the saved plan's stamp refuses a plan whose records moved (plunge exit 40, chant's moved code 4). On stock Pulumi the apply previews again, then compares the steps in `up`'s event stream with the approved shape (`src/plan-shape.ts`), and a step outside it fails the apply. A member on the resource lock grain, the default on plunge, leaves `same` and `read` steps out of its digest. The step's `config` is written into a scratch copy of `Pulumi.<stack>.yaml` and passed with `--config-file`, never `--config`, which writes the working tree's file. A release cut records the stack's directory (`releaseInputs`), unless its backend is a file path relative to that directory. Under a release, a promote or rollback previews and applies the recorded copy, after `pulumi install` (or `plunge install`) in the copy when its runtime needs one (`src/release-copy.ts`); a Node copy with no recorded lockfile is refused by name. A job's checkout gets the same install before its first engine run when nothing installed the program there (`prepareProgram`), and a Node checkout with no lockfile is refused by name.

After `up`, the capability runs `stack export --stack <s>`, replaces every secret with `[secret]`, drops the secrets provider's state, and writes the export through chant's index store as `<env>/<stack>__pulumi-export` ([#4546](https://github.com/INTENTIUS/chant/issues/4546), `refs/chant/snapshots` by default). The graph, the preview's prior state and the drift read take that export first, so a stack chant applies needs no checked-in `stack-export.json`. A failed export leaves the apply standing and says why in the step's `exportSnapshot` output.

A program that reads another stack through `StackReference` orders its stack after that one ([#4547](https://github.com/INTENTIUS/chant/issues/4547), `src/stack-references.ts`). The capability's `declaredReads` reads each step's export for `pulumi:pulumi:StackReference` resources, matches each `name` to the other `pulumi-up` step with that `Pulumi.yaml` name and stack, and reports a read of each output the export recorded that is not secret. Core writes those reads into the step's `stackReferences` input and adds a `dependsOn`, so the waves put the referenced stack first, a failed upstream holds the reader, and a reader waits while the upstream's plan cannot say a value it reads. A reference to a stack no step applies adds no edge, and the plan's artifact names it under `stackReferences.outside`.

## Adoption: `PulumiAdoptOp`

`PulumiAdoptOp` (`src/composites/pulumi-adopt-op.ts`, [#4562](https://github.com/INTENTIUS/chant/issues/4562)) adopts stock stacks onto plunge's per-resource records, the pulumi twin of `TerraformAdoptOp`. Its phases are Check (the shared bucket check on the backend's bucket), Export (`pulumi stack export --stack <s>` into a scratch file), then per stack Preview (`plunge stack adopt --json`), a gate bound to the preview's digest, and Adopt (`plunge stack adopt --json --yes`, through `runAdoptPlunge`). `from: { backend }` or `from: { file }` adopts an export with `--file`, the route from Pulumi Cloud. Gates and the run are recorded on the workspace ledger.

## Gated stack operations

`src/stack-ops.ts` ([#4578](https://github.com/INTENTIUS/chant/issues/4578)) runs stack operations, each only after its gated request (#4551) is approved on the workspace ledger by someone other than the requester, under the op `pulumi-stack-ops`. The first call records the request and returns the `chant approve` command; the same call after the approval spends it, runs once, and records how it ended.

| Function | Request | What runs after approval |
|---|---|---|
| `gatedStackExport` | `stack-export` of `<stack>` | `pulumi stack export --stack <s>` (or plunge's), written mode 600 to a file outside every git working tree; refused in CI |
| `gatedStackCancel` | `stack-cancel` of `<stack>` with its lock id | `pulumi cancel --yes --stack <s>`, once the lock is still the approved one (read from a `file://` backend's lock directory); refused on plunge, which has no stack lock |
| `gatedStackMove` | `stack-move` of `move:<source>:<dest>` with the URNs | `pulumi state move --source <s> --dest <d> --yes <urn>...`, or `plunge stack move --stack <s> --dest <d> <urn>... --json --yes` after plunge's plan; both stacks preview first, and the move runs only when the previews change nothing but the moved resources |
| `gatedStackAction` | `stack-action` of `action:<stack>:<name>` with the URN and the preview's digest | `pulumi up --yes --target <urn> --replace <urn> --stack <s>` (or plunge's), once ([#4654](https://github.com/INTENTIUS/chant/issues/4654)); see below |

`pulumiStackLockIds({ dir, stack })` ([#4615](https://github.com/INTENTIUS/chant/issues/4615)) reads the lock ids a stack holds now, the same read `gatedStackCancel` checks with, so a product can offer the id to approve. It answers `checked: false` on a backend other than `file://`, and no ids for a plunge stack.

A day-2 action on a stack is a `command:local:Command` or `command:remote:Command` resource whose replacement is the operation, such as a key rotation. `gatedStackAction({ dir, stack, urn, name, engine, ... })` refuses any other resource type with `action-type` before anything runs. Each call previews `preview --json --target <urn> --replace <urn> --stack <s>` and refuses with `action-scope`, naming the other URNs, when the preview changes anything besides that one replacement; nothing is asked for then. The request binds the stack, the URN and the preview's digest, so a preview that changed after the approval asks again. Once approved, the update runs, and the finished line keeps `result: applied` (or `failed`) with `detail.result` set to `ok` (or `failed`), the exit code and the last lines of output. The same call after it ran answers `spent`, unless it passes `anew`. A stack on plunge runs both through plunge.

The writes go through `runGatedPulumi` and `runGatedPlunge` in `src/run.ts`, whose fixed forms (`PULUMI_GATED_COMMANDS`, `PLUNGE_GATED_COMMANDS`) are the only ones allowed.

## Drift: `chant workspace drift`

`chant workspace drift --member <pulumi member> [--resource <urn>] [--stream]` runs `chant lifecycle drift` in the member's reader project, which calls this lexicon's `readDrift`. A stock member is read with one `pulumi refresh --preview-only --json --target <urn>` per resource in its checked-in `stack-export.json`. A member on plunge is read with `plunge drift --resource <urn> --stream` per resource. `--resource` reads one URN. The only read is `refresh`.

A member runs on plunge when its config says `engine: "plunge"`, or when `Pulumi.yaml` names a backend URL starting with `plunge` (`plunge+file://...`, `plunge://...`). Only `Pulumi.yaml` is read, never `PULUMI_BACKEND_URL` or login state.

## Engine facts for a member on plunge

plunge keeps a record per resource, and `plunge graph --json` prints the stack's graph from those records in the engine graph document chant#4520 designed. It makes no provider call and prints no output value. chant reads it two ways ([#4529](https://github.com/INTENTIUS/chant/issues/4529)):

- `describeResources` runs `plunge graph --json --stack <stack>` once per member, with the stack the other reads use. Each node becomes a resource keyed like the member graph's node, with plunge's facts on `ResourceMetadata.facts`. Every resource has `ownership: "unknown"` and no marker, so no change set or teardown decides from it.
- The graph read takes a checked-in `engine-graph.json` beside `stack-export.json`. Its facts go on the nodes (`nodes[].facts`) and its `property` edges join the graph with `grain: "property"`. The export's `dependencies` and `parent` edges carry `grain: "instance"`.

plunge's markers say `source: "record"`: what its record says it wrote, not a read of the object. A stock member gets neither read, and chant runs nothing new for it. Record versions (`--versions`) cost one listing per record, so `describeResources` leaves them off.

## Outputs into another member's parameters

A chant member reads a Pulumi member's outputs with core's `member-outputs` verb (chant#4455):

```ts
import { memberOutputsComponent } from "@intentius/chant/components/verbs/member-outputs";

export const aws = memberOutputsComponent("aws");
export const records: Component = {
  name: "records",
  dependsOn: ["aws"],
  deploy: [phase("Apply", [cfnDeploy({ template: "dist/dns.json", inputs: { awsEndpoint: stackOutput("aws", "awsEndpoint") } })])],
};
```

The consumer lists `pulumi` among its lexicons, which brings `pulumiCapabilityPlugin` and its source, `pulumiOutputSource`, for members of kind `pulumi`.

- Applied values come from `pulumi stack output --json --show-secrets=false` in the member's directory. With `CHANT_PULUMI_APPLIED_OUTPUTS=export`, chant runs nothing and reads them from the checked-in `stack-export.json`.
- Planned values come from `pulumi preview --json --show-sames`. A real preview carries no outputs on the stack's `pulumi:pulumi:Stack` step (recorded, #4475), so a preview with nothing to apply gives the checked-in export's outputs and one with changes leaves every output unknown. An output a stack step does carry is read, and one holding Pulumi's unknown sentinel is unknown. The consumer is planned without an unknown output, gets a hole on `aws#outputs` naming it, and is held back on merge until the member applied, then planned again.
- The plan digest is the member part's `pulumi-preview` digest, so a preview that moves after review moves the consumer's digest.
- While the preview still has changes, `run` refuses and the consumer is blocked behind the member.
- Secret outputs are left out of both reads. chant never carries or prints their values.
- A member on plunge runs the same commands under `plunge`.
- Both commands run against the member's selected stack.

```bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-pulumi
```

## License

See the main project LICENSE file.
