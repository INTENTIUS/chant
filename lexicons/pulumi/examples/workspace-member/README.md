# workspace-member

A chant workspace with one Pulumi member, `infra/`: a Pulumi YAML program
with its project file, a `dev` stack config and the checked-in
`stack-export.json` chant reads its graph from.

- `chant.workspace.json` declares `infra` as a member of kind `pulumi` and
  pins `@intentius/chant-lexicon-pulumi`, which supplies the kind.
- `chant.config.ts` reads the member into this project's own build, so
  `npx chant build` and `npx chant lint` run the lexicon's checks against it.

`chant workspace graph` puts the bucket and its versioning on two nodes,
`infra/aws:s3/bucketV2:BucketV2::assets` and
`infra/aws:s3/bucketVersioningV2:BucketVersioningV2::assetsVersioning`, with
an edge between them. The change set and drift need a selected stack and
credentials (`pulumi preview` and `pulumi refresh --preview-only` run against
it); the graph needs neither.

After `pulumi up`, refresh the export with
`pulumi stack export --file stack-export.json` in `infra/` and commit it.

See https://intentius.io/chant/lexicons/pulumi/.
