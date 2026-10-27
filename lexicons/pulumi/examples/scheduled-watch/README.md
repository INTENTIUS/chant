# scheduled-watch

The `workspace-member` layout with a watch on it. `src/watch.op.ts` builds a
`PulumiWatchOp` over `infra/`: a preview, then a targeted
`pulumi refresh --preview-only` per resource in the checked-in
`stack-export.json`, every morning at 06:00.

Run it once locally, with a selected `dev` stack and credentials for it:

```bash
chant run infra-watch
```

The run publishes two outcomes. `Changes` is true when the preview plans a
create, update, replace or delete, or a resource that may appear on apply.
`Drift` is the count of resources drifted or missing. Neither phase applies
anything, and there is no option that does: the stack's owner reads the
outcome and runs `pulumi up` themselves.

`drift: false` on the Op leaves the drift phase out, for a stack whose refresh
is too slow to run every day.

See https://intentius.io/chant/lexicons/pulumi/watching/.
