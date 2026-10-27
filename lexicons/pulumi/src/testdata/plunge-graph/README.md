# plunge-graph

A member on plunge with a checked-in `engine-graph.json` (chant#4529). Both files are hand-written; nothing ran.

- `engine-graph.json` is a byte-for-byte copy of `packages/core/src/graph-schema/fixtures/plunge.engine-graph.json`, the typed fixture chant#4527 writes from `fixtures.ts` in the shape `plunge graph --json` prints (INTENTIUS/plunge#40, #43). `engine-graph.test.ts` fails when the two differ.
- `stack-export.json` is a minimal `plunge stack export` for the same stack (`app`, `dev`): the root stack, the default aws provider, the buckets `assets` and `media`, and the bucket policy `assets-policy`, which depends on `assets` through its `bucket` property.

The graph says `assets-policy` is a pending create and the export holds it as a resource: the graph was taken mid-update and the export after it. chant copies the facts as plunge printed them and does not reconcile the two files, which the tests show.

`Pulumi.yaml` names a placeholder `plunge+file://` backend, so the member runs on plunge.

A recorded pair (one `plunge up` on floci, then `plunge stack export` and `plunge graph --json --stack dev`) waits for a maintainer run.
