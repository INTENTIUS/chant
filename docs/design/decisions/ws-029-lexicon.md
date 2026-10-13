---
schema: 1
id: "ws-029"
title: "Lexicon"
state: "decided"
area: "D1"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Lexicon (v8)"
  revision: "v8"
question: "Is the workspace declaration authored only as JSON, or can a TypeScript lexicon generate it?"
options:
  - id: "a"
    label: "JSON manifest plus an optional generating lexicon"
    how: "`chant.workspace.json` stays the contract that readers parse. A workspace lexicon in a member may declare the workspace in typed TS. It writes the manifest and the CI files as committed D14 generated files."
    tradeoff: "Authors who want types get them while readers never run TS, which breaks the build-order cycle. The generated manifest needs a drift check against its lexicon."
  - id: "b"
    label: "TS init helper"
    how: "`chant workspace init` offers a typed TS helper that writes the manifest once. Nothing reads TS at runtime."
    tradeoff: "It adds no lexicon to chant. After the first write the manifest is edited by hand with no typed source behind it."
    chosen_in: "v6"
  - id: "c"
    label: "JSON only"
    how: "The declaration is written by hand with no typed helper."
    tradeoff: "Simplest for readers and for chant. Authors of large workspaces get no types and no generated CI files."
choice:
  option: "a"
  reason: "The choice was revised in v8 away from the TS init helper that v6 chose; the earlier choice is in the #2524 edit history. D1 keeps the manifest as the contract so readers list members without running TS. The optional lexicon regenerates the manifest and the CI files that D19 needs for per-member pipelines. The source is ambiguous because v8 does not say directly what was wrong with the helper. v6 had also rejected a TS lexicon compiled to the manifest, which is close to what v8 chose."
rejected:
  - option: "b"
    why: "A helper that writes the manifest once leaves nothing that can regenerate it later. It also cannot produce the per-member CI files that D19 generates."
  - option: "c"
    why: "Hand-written JSON alone leaves authors without types or a source for generated CI files."
supersedes:
  - revision: "v6"
    option: "b"
evidence:
  - title: "INTENTIUS/chant#2524, D1. The declaration"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d1-the-declaration"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, D14. Generated files"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d14-generated-files"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Lexicon (v8)"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2534, the declaration, findWorkspaceRoot, chant workspace init and ls"
    url: "https://github.com/INTENTIUS/chant/issues/2534"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2534"
  - "INTENTIUS/chant#2541"
  - "INTENTIUS/chant#2542"
---

# Lexicon
