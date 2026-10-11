---
schema: 1
id: "sql-001"
title: "Typed columns reach tsc"
state: "decided"
area: "sql"
source:
  issue: "INTENTIUS/chant#3751"
  row: "Decide how the declarations reach `tsc`"
  revision: null
question: "How do a SQL schema's column types reach plain tsc, given that tsc sees a tagged template's text only as a TemplateStringsArray?"
options:
  - id: "a"
    label: "generated SqlSchema augmentation, name as type argument"
    how: "Each dialect declares an empty `SqlSchema` interface keyed by qualified name. `chant sql types` writes one generated module, `<sourceDir>/sql-types.d.ts`, that augments it from the fold build's entities, `.sql` objects included. `table`, `view` and ClickHouse `dictionary` take the name as a type argument (`` table<\"shop.orders\">`...` ``) and return the entry's columns, each branded with its SQL type; per-position `slots` type the `${}` a foreign key or a sort key consumes. `RowOf` takes the name or `typeof` a typed declaration."
    tradeoff: "Checks run inside schema source and cover `.sql` objects by name, and nothing changes at build time. The checks are only as current as the generated file, so they need a staleness check, and a slot exists only where a key interpolates its column."
  - id: "b"
    label: "a generated re-export module"
    how: "The generator writes a module that re-exports each declaration with its columns typed, and application code imports from it instead of the schema files."
    tradeoff: "Application code gets typed columns without a type argument, but a template cannot import the re-export module without a cycle, so nothing in schema source is checked."
  - id: "c"
    label: "a sibling .d.ts per source module"
    how: "The generator writes `orders.d.ts` beside `orders.ts`, declaring the module's exports with typed columns."
    tradeoff: "No change to how declarations are written, but TypeScript resolves `./orders` to `orders.ts` before `orders.d.ts`, so the declaration file is never in the program."
choice:
  option: "a"
  reason: "It is the only option the spike found that checks column references inside schema source. In a scratch project under strict compiler options, tsc 5.9.3 reported exactly the planted errors: a misspelled `${orders.columns.emial}` (TS2551 with a suggestion), a `text` column's foreign key to a `bigint` column (TS2345 on the `${}` that names it), a Nullable column in a materialized view's interpolated ORDER BY (TS2345), and `RowOf` of an unknown name or an untyped table (TS2344). An untyped relation keeps today's behaviour, so a project adopts the type argument one declaration at a time. The type argument leaves the build output byte-identical, folded or run, and the cost was 1.4s of checking for 1000 tables of 25 columns. The generated file must be a module, since a non-module's `declare module` replaces the package."
rejected:
  - option: "b"
    why: "A template cannot import the re-export module without an import cycle, so nothing in schema source would be checked."
  - option: "c"
    why: "The spike confirmed it: `tsc --listFilesOnly` lists only `orders.ts`, and `orders.columns.idd` compiles."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3047, question 2: syntax, round trip and the typing strategy"
    url: "https://github.com/INTENTIUS/chant/issues/3047"
    as_of: null
  - title: "INTENTIUS/chant#3751, step 0 decided after a spike"
    url: "https://github.com/INTENTIUS/chant/issues/3751#issuecomment-6113018455"
    as_of: "2026-10-11T19:48:14Z"
decided_by: "lex00"
decided_on: "2026-10-11"
reviews: []
constrains:
  - "INTENTIUS/chant#3751"
---

# Typed columns reach tsc
