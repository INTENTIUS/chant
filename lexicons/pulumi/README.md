# @intentius/chant-lexicon-pulumi

Pulumi lexicon for [chant](https://intentius.io/chant/). It adds your Pulumi program to a chant workspace as it is, on stock Pulumi or on [plunge](https://github.com/INTENTIUS/plunge), a Pulumi fork that keeps chant's ownership markers on each resource. It declares no resource types. It supplies the `pulumi` workspace member kind and reads a Pulumi program four ways:

| Read | Source | Module |
|---|---|---|
| the member's graph | the `pulumi stack export` checked in as `stack-export.json` | `src/workspace-member.ts` |
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

The preview streams its engine events (`PULUMI_ENABLE_STREAMING_JSON_PREVIEW=true`, `src/engine-events.ts`), so one run gives the change set and CrossGuard's findings. A mandatory violation denies the plan. On plunge the saved plan's stamp refuses a plan whose records moved (plunge exit 40, chant's moved code 4). On stock Pulumi the apply previews again, then compares the steps in `up`'s event stream with the approved shape (`src/plan-shape.ts`), and a step outside it fails the apply. A member on the resource lock grain, the default on plunge, leaves `same` and `read` steps out of its digest. The step's `config` is written into a scratch copy of `Pulumi.<stack>.yaml` and passed with `--config-file`, never `--config`, which writes the working tree's file. A release cut records the stack's directory (`releaseInputs`), unless its backend is a file path relative to that directory.

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
