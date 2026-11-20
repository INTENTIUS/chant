# disruption

`preview-delete-first.json` is hand-written for #5338, in the shape of `pulumi preview --json`'s steps: a replacement whose `delete-replaced` comes before its `create-replacement` (a resource with `deleteBeforeReplace`), one whose delete comes after, and a create. The recorded preview in `../pulumi-preview/preview.json` has no delete-first replacement, since a stock `pulumi preview` prints a replace as one `replace` step.
