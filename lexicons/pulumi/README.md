# @intentius/chant-lexicon-pulumi

Pulumi lexicon for [chant](https://intentius.io/chant/). It declares no resource types. It supplies the `pulumi` workspace member kind and reads a Pulumi program four ways:

| Read | Source | Module |
|---|---|---|
| the member's graph | the `pulumi stack export` checked in as `stack-export.json` | `src/workspace-member.ts` |
| its change-set part | `pulumi preview --json` | `src/change-set.ts` |
| its drift records | `pulumi refresh --preview-only --json --target <urn>`, one resource at a time | `src/drift-record.ts`, `src/drift-read.ts` |
| its stack outputs, for another member's parameters | `pulumi stack output --json --show-secrets=false` (applied) and `pulumi preview --json` (planned) | `src/stack-outputs.ts`, `src/member-outputs.ts` |

The graph read never runs `pulumi`. The change set and drift run `preview` and `refresh --preview-only`, and the outputs read adds `stack output --json --show-secrets=false`. A member on plunge runs `plunge preview`, `plunge stack output --json --show-secrets=false` and `plunge drift --resource <urn> --stream`. That is the whole list, as ruled on [#4476](https://github.com/INTENTIUS/chant/issues/4476) (2026-10-25), which widened the [#4450](https://github.com/INTENTIUS/chant/issues/4450) ruling's `preview` and `refresh --preview-only` to keep the outputs read and the plunge commands. Nothing else runs (`runAllowedPulumi` and `runAllowedPlunge` refuse any other argv), so chant never changes a stack. With `CHANT_PULUMI_APPLIED_OUTPUTS=export`, the outputs read runs nothing either.

## Drift: `chant workspace drift`

`chant workspace drift --member <pulumi member> [--resource <urn>] [--stream]` runs `chant lifecycle drift` in the member's reader project, which calls this lexicon's `readDrift`. A stock member is read with one `pulumi refresh --preview-only --json --target <urn>` per resource in its checked-in `stack-export.json`. A member on plunge is read with `plunge drift --resource <urn> --stream` per resource. `--resource` reads one URN. The only read is `refresh`.

A member runs on plunge when its config says `engine: "plunge"`, or when `Pulumi.yaml` names a backend URL starting with `plunge` (`plunge+file://...`, `plunge://...`). Only `Pulumi.yaml` is read, never `PULUMI_BACKEND_URL` or login state.

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
