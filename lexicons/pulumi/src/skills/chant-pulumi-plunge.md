---
skill: chant-pulumi-plunge
description: Read a Pulumi member that runs on plunge (a plunge backend URL or engine plunge), with plunge preview, plunge stack output and plunge drift
user-invocable: true
---

# A Pulumi Member on plunge

plunge is a Pulumi fork with its own state backends. A member runs on plunge when its `pulumi.member` config says `engine: "plunge"`, or when its `Pulumi.yaml` has a `backend.url` starting with `plunge` (`plunge+file://...`, `plunge://...`). Only `Pulumi.yaml` decides when the config does not; `PULUMI_BACKEND_URL` and the CLI's login state are never read, so every checkout gets the same answer.

## What chant runs

| Read | Command |
|---|---|
| graph | none; the checked-in `stack-export.json`, as for a stock member |
| change set | `plunge preview --json` |
| applied outputs | `plunge stack output --json --show-secrets=false` |
| drift | `plunge drift --resource <urn> --stream --stack <name>`, one per resource |

Nothing else runs. `runAllowedPlunge` refuses any other argv before it reaches the binary, so chant never changes the stack. The drift stream is drift-record NDJSON, which chant places on nodes by the same URN rule the graph uses.

## Declaring the member

The workspace entry is the same as for a stock member (kind `pulumi`). With a plunge backend URL in `Pulumi.yaml`, nothing else is needed. To read the member into a build, or to say plunge without a plunge URL:

```ts
import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-pulumi";

export default {
  lexicons: ["pulumi"],
  pulumi: { member: { dir: "./site", label: "site", engine: "plunge" } },
} satisfies ChantConfig;
```

Do not write `engine: "pulumi"` for a program on a plunge backend: stock `pulumi` cannot open it, and PUL015 reports the mismatch.

## Watching it

```ts
import { PulumiWatchOp } from "@intentius/chant-lexicon-pulumi";

export const { op } = PulumiWatchOp({ name: "site-watch", member: "site", dir: "./site", engine: "plunge", schedule: "0 6 * * *" });
```

`chant init --lexicon pulumi --template plunge` writes this project. The stack export is taken the same way, with `plunge stack export --file stack-export.json` (see the `chant-pulumi-stack-export` skill).

Never run `plunge up`, `plunge destroy` or any command outside the table for the user, and never point a member at a real cloud account to try it.
