---
skill: chant-cedar-authoring
description: Author Cedar authorization policies as typed chant resources — schema to generated classes to .cedar and JSON outputs
user-invocable: true
---

# Cedar Policies as Typed Resources

## What this lexicon covers

Cedar is an authorization policy language. Its toolchain validates and evaluates
policies; it does not help you write them. There are no functions, no modules,
no loops, and templates carry exactly two slots (`?principal`, `?resource`), so
teams managing large policy sets generate `.cedar` text with string templating.
This lexicon replaces that with typed TypeScript.

Two artifacts come out of every build:

- `<name>.cedar` — the policy text every Cedar evaluator reads (Amazon Verified
  Permissions, cedar-agent, an embedded `cedar-wasm`).
- `policies.cedar.json` — the same set in the Cedar JSON policy format, beside
  it. This is also the parse source for import.

chant is nowhere in either. An emitted policy set is consumed by any evaluator.

## The three steps

### 1. Declare a schema

The schema is *your* file, not a global upstream — it is the input codegen
reads. Write it in Cedar's human-readable syntax and point the config at it:

```typescript
// chant.config.ts
import type { ChantConfig } from "@intentius/chant";
import "@intentius/chant-lexicon-cedar";

export default {
  lexicons: ["cedar"],
  cedar: {
    schema: "authz/app.cedarschema",
    validation: { mode: "strict", requireProjectSchema: true },
  },
} satisfies ChantConfig;
```

Turn `requireProjectSchema` on once the project has its own schema. Without it a
missing file silently falls back to the bundled default, and the difference
between "your entity types" and "somebody else's" is invisible.

### 2. Run generate

```bash
npx chant cedar generate
```

The output is written into the project, at `src/generated/cedar/` (or
`cedar.outDir`), never into `node_modules`. Commit it or regenerate it in CI;
re-run it whenever the schema changes. Policies import from that directory,
not from `@intentius/chant-lexicon-cedar`, whose own `Policy` and classes
describe the package's bundled sample schema.

That produces, per declaration in the schema:

| Schema declaration | Generated |
|---|---|
| `entity Document in [Folder] = { … }` | `Document` class, `DocumentAttributes` property class, `DocumentUid` template-literal type |
| `action read appliesTo { … }` | `ReadAction` constant, `ReadContext` property class |
| — | `Policy` class, `EntityTypeName`, `ActionUid`, `PolicyScope`, `ALL_ACTIONS`, `ALL_ENTITY_TYPES` |

`DocumentUid` is `` `App::Document::"${string}"` `` — a typo'd namespace is a
compile error, not a validation error hours later.

### 3. Write policies

```typescript
import { Policy, ReadAction, WriteAction, type UserUid } from "./generated/cedar";

const archivist: UserUid = 'App::User::"archivist"';

export const ownerRead = new Policy({
  effect: "permit",
  principal: { is: "App::User" },
  action: { in: [ReadAction, WriteAction] },
  resource: { is: "App::Document" },
  when: ["resource.owner == principal"],
  annotations: { doc: "Owners always read their own documents." },
});

export const restrictDelete = new Policy({
  effect: "forbid",
  resource: { is: "App::Document" },
  when: ['resource.classification == "confidential"'],
  unless: [`principal == ${archivist}`],
});
```

## Policy props

| Prop | Meaning |
|------|---------|
| `effect` | `"permit"` or `"forbid"`. Defaults to `permit` |
| `principal`, `action`, `resource` | Scope constraints. Omit for unconstrained |
| `when` | Cedar expression strings, one `when { … }` clause each |
| `unless` | Cedar expression strings, one `unless { … }` clause each |
| `annotations` | `Record<string, string>`, emitted as `@key("value")` |

### Scope forms

| Written | Emitted |
|---|---|
| `{}` or omitted | `principal` |
| `{ eq: X }` | `principal == X` |
| `{ in: X }` | `principal in X` |
| `{ in: [X, Y] }` | `principal in [X, Y]` |
| `{ is: "App::User" }` | `principal is App::User` |
| `{ is: "App::User", in: X }` | `principal is App::User in X` |

`when`/`unless` stay strings. Cedar's expression grammar *is* the policy
language; typing it in TypeScript is a separate problem, and the escape hatch
would leak either way.

## Policy ids

The id comes from the export's logical name, kebab-cased: `allowAdminRead`
becomes `@id("allow-admin-read")`. Set `annotations.id` to pin one explicitly —
worth doing for a policy whose id something downstream references.

## Composites

Repeated policy shapes go in a factory, because Cedar has nowhere to put them.

```typescript
import {
  DeleteAction,
  DenyByDefaultSet,
  OwnerCanManage,
  ReadAction,
  WriteAction,
} from "@intentius/chant-lexicon-cedar";

const docOwner = OwnerCanManage({
  entityType: "App::Document",
  actions: [ReadAction, WriteAction],
  principal: "App::User",
});

const guarded = DenyByDefaultSet({
  policies: [docOwner],
  entityType: "App::Document",
  actions: DeleteAction,
  when: ['resource.classification == "confidential"'],
  unless: ['principal == App::User::"archivist"'],
});

export const [confidentialFloor, documentOwnerGrant] = guarded.all;
```

`DenyByDefaultSet` returns the `forbid` floor and its members from one call, so
deleting the floor deletes the grants with it. A `forbid` beats every `permit`
in the set unconditionally — it is the only construct that survives a later,
wider grant.

## Checking the result

```bash
npx chant build                         # emits both artifacts, runs the CED rules
npx chant cedar coverage                # is every schema declaration generated?
```

The MCP tool `cedar:coverage` answers the other question: which schema entity
types and actions the *policy set* can reach, which are reachable only from a
`forbid`, and which no policy touches at all. An entity type nothing covers is
inert under Cedar's default-deny — either the intent or a hole.

## Things that will bite

- **An empty schema validates everything clean.** `checkParseSchema("")`
  succeeds. Set `requireProjectSchema: true`.
- **`Group` and `Team`-shaped container entities appear in no `appliesTo`.**
  They exist to be `in`, so no policy — not even `permit (principal, action,
  resource)` — resolves to them. `cedar:coverage` reports that honestly rather
  than rounding it up.
- **A policy naming an entity type outside the schema still parses.** It
  resolves to an empty request envelope and never fires. `cedar:coverage`
  reports it under `inert`.
