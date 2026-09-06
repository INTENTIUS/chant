# scheduled-watch

A terraform root watched on a cron. `ops/watch.op.ts` builds a
`TerraformWatchOp` over the `app` root declared in `chant.config.ts`: init,
plan with `-detailed-exitcode`, and, when the plan is not empty, a GitHub
issue whose body is the `terraform plan -no-color` render.

Run it once locally:

```bash
chant run app-watch
```

Generate the GitHub Actions workflow that runs it nightly. There is no CLI
for this yet, so it is the `generateOpsPipeline` call itself:

```ts
import { generateOpsPipeline } from "@intentius/chant/op";

const { files } = await generateOpsPipeline(
  [{ name: "app-watch", schedule: "0 6 * * *", findingMode: "issue" }],
  "github",
  { beforeScript: ["curl ... && unzip ..."] },
);
```

The workflow carries the cron, `workflow_dispatch` so it can be run by hand,
a per-Op concurrency group so a slow plan never overlaps its own next trigger,
and `issues: write`, nothing more, because `findingMode: "issue"` needs
nothing more. The runner has no terraform on it, so the install is passed in
as a `beforeScript` line; `../examples.test.ts` pins the whole emitted
document, install line included, and is the copyable form of the call above.

Only the human plan is ever posted. `terraform show -json` over a plan file
carries resource attribute values, provider secrets among them, so the Op
references the `-no-color` render and there is no option to post the other.

The `schedule` export is a `Temporal::Schedule` for a project that runs
Temporal. A project that does not can ignore it: the CI cron above is the
same trigger by another route.
