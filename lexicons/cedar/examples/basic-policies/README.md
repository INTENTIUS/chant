# basic-policies

A four-policy Cedar policy set authored against types generated from
`schema.cedarschema`.

```
chant build
```

produces two files from the same in-memory model:

- `policies.cedar` — the human-facing policy text, and the surface every Cedar
  evaluator reads (AVP, cedar-agent, an embedded `cedar-wasm`)
- `policies.cedar.json` — the machine-facing Cedar JSON policy format, which is
  also what import reads back

## What the types buy

`src/policies.ts` imports `ReadAction`, `WriteAction`, `DeleteAction` and
`UserUid` from the lexicon. Those come from `schema.cedarschema` by way of
`chant generate` — so an action the schema never declared, or an entity type
name with a typo in it, fails to compile. Cedar's own validator catches the
same class of mistake, but only after the policy text has been written and
only if it is run.

The `is` constraints are typed too: `resource: { is: "App::Document" }`
compiles, `resource: { is: "App::Documnt" }` does not.

## Regenerating

`chant.config.ts` points `cedar.schema` at this directory's schema:

```ts
export default {
  lexicons: ["cedar"],
  cedar: { schema: "schema.cedarschema" },
} satisfies ChantConfig;
```

Edit the schema, re-run `chant generate`, and a renamed entity type becomes a
compiler-guided refactor rather than a find-and-replace over policy text.
