# plunge-member

A chant workspace with one Pulumi member that runs on plunge, a Pulumi fork
with its own state backends. `infra/` is the `workspace-member` example's
program with one change: `backend.url` in `infra/Pulumi.yaml` is
`plunge+file://./.plunge-state`.

That URL is how chant tells. A member runs on plunge when its config says
`engine: "plunge"`, or when `Pulumi.yaml` names a backend URL starting with
`plunge`. chant reads only `Pulumi.yaml` for this, never
`PULUMI_BACKEND_URL` or the CLI's login state, so every checkout agrees.

| Read | Command |
|---|---|
| graph | none; `infra/stack-export.json` |
| change set | `plunge preview --json` |
| applied outputs | `plunge stack output --json --show-secrets=false` |
| drift | `plunge drift --resource <urn> --stream`, one per resource |

`src/watch.op.ts` watches the member the same way `scheduled-watch` does, and
sets no `engine`: the backend URL decides there too.

After `plunge up`, refresh the export with
`plunge stack export --file stack-export.json` in `infra/` and commit it.

See https://intentius.io/chant/lexicons/pulumi/plunge/.
