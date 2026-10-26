---
skill: chant-pulumi
description: Add a Pulumi program to a chant workspace as a member, read its preview into the change set and its refresh as drift, and watch it with PulumiWatchOp
user-invocable: true
---

# A Pulumi Program as a Workspace Member

## What this lexicon covers

The pulumi lexicon declares no resource types and writes nothing. The Pulumi program, its `Pulumi.yaml` and its stack config stay the source of truth, and `pulumi up` stays the stack owner's command. chant reads the member and runs only these commands, none of which changes the stack:

| Read | Stock member | Member on plunge |
|---|---|---|
| graph | the checked-in `stack-export.json` | the same |
| change set | `pulumi preview --json` | `plunge preview --json` |
| drift | `pulumi refresh --preview-only --json --target <urn>` | `plunge drift --resource <urn> --stream` |
| applied outputs | `pulumi stack output --json --show-secrets=false` | `plunge stack output --json`, the same |

Any other argv is refused before it reaches the binary.

## Adding the member

List the directory that holds `Pulumi.yaml` in `chant.workspace.json` with kind `pulumi`, and pin the lexicon:

```json
{
  "name": "shop",
  "schema": 1,
  "pins": [{ "package": "@intentius/chant-lexicon-pulumi", "version": "<version>" }],
  "members": [{ "name": "infra", "dir": "infra", "kind": "pulumi" }]
}
```

Check in the stack's export beside `Pulumi.yaml`, so the graph has nodes:

```bash
cd infra && pulumi stack export --file stack-export.json
```

Without it the member has no nodes, and a build that reads it reports PUL001. An export taken after an interrupted update reports PUL002; resolve the pending operations (`pulumi refresh`) and export again.

## Plan and drift

- `chant workspace plan` puts the member's `pulumi preview --json` in the change set, one entry per URN. Resources a program registers inside an `apply()` the preview could not run are marked `mayAppear`.
- `chant workspace drift --member infra [--resource <urn>] [--stream]` reads one targeted refresh per resource in the export.
- Another member reads the stack's outputs as parameters with `member-outputs`; the consumer lists `pulumi` among its lexicons.

A member runs on plunge when its config says `engine: "plunge"`, or when `Pulumi.yaml` has a `backend.url` starting with `plunge`. Only `Pulumi.yaml` decides, never `PULUMI_BACKEND_URL` or the CLI's login state.

## Watching a member

`PulumiWatchOp` previews the member and reads its drift on a schedule. It never applies.

```ts
import { PulumiWatchOp } from "@intentius/chant-lexicon-pulumi";

export const { op } = PulumiWatchOp({
  name: "infra-watch",
  member: "infra",
  dir: "./infra",
  stack: "dev",
  schedule: "0 6 * * *",
});
```

The run publishes `Changes` (the preview plans something) and `Drift` (resources drifted or missing). `drift: false` leaves the drift phase out. Add `"pulumi"` to `lexicons` in `chant.config.ts` so the `pulumiPreview` and `pulumiDrift` activities load.

## Reading the member into a build

A project can read the member's graph into its own `chant build`:

```ts
import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-pulumi";

export default {
  lexicons: ["pulumi"],
  pulumi: { member: { dir: "./infra", label: "infra" } },
} satisfies ChantConfig;
```

Write `dir` relative to the project root; PUL101 warns on an absolute path.
