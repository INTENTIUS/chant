# @intentius/workspace-kind-choudoufu

The `choudoufu` member kind for a chant workspace, published as data. The
package holds one JSON file and no code.

A member of this kind is a Terraform root that [choudoufu](https://github.com/INTENTIUS/choudoufu)
runs live under an estate. Its directory holds an `estate.chdf.hcl` sidecar, or
one of its `.tf` files opens a `live` block. That is the same probe behold used
for its own `choudoufu` member, and this package replaces that entry in behold's
closed list of kinds.

## Use

Install the package and pin it in `chant.workspace.json`, then declare members
of the kind.

```bash
npm install --save-dev @intentius/workspace-kind-choudoufu
```

```json
{
  "name": "estate",
  "schema": 1,
  "pins": [{ "package": "@intentius/workspace-kind-choudoufu", "version": "1.0.0" }],
  "members": [{ "name": "networking", "dir": "networking", "kind": "choudoufu" }]
}
```

chant finds the file through the package's `./workspace-kinds` export and
reads it from disk. It never imports the package.

## Precedence

The kind has precedence 450. A directory holding a live root also passes the
probe of `terraform` (400, from `@intentius/chant-lexicon-terraform`), and
choudoufu outranks it, as it did in behold. A chant project (500) outranks both.

See [Workspace Kinds](https://intentius.io/chant/reference/workspace-kinds/) for
the format.
