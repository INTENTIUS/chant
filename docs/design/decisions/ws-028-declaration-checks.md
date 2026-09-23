---
schema: 1
id: "ws-028"
title: "Declaration checks"
state: "decided"
area: "D16"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Declaration checks"
  revision: null
question: "What contract do checks on the workspace declaration use?"
options:
  - id: "a"
    label: "`WorkspaceCheck`"
    how: "A `WorkspaceCheck` contract reuses the post-synth diagnostic shape. Findings carry `WSP` ids from the audit catalog and go through lint's reporters. The declaration sets their severity and suppression."
    tradeoff: "It adds one small contract and reuses lint's output formats, SARIF included. `chant lint` itself never loads workspace code."
  - id: "b"
    label: "core lint"
    how: "Declaration checks are written as core lint rules that `chant lint` runs."
    tradeoff: "No new contract is needed. `chant lint` would have to load workspace code and would reach past one project's source."
  - id: "c"
    label: "ad hoc"
    how: "Each workspace command checks what it needs in its own code and prints its own errors."
    tradeoff: "Fastest to write. Findings would lack stable ids and could not be suppressed."
choice:
  option: "a"
  reason: "D16 puts the declaration under `workspace check`. A `WorkspaceCheck` contract lets those findings reuse lint's reporters and the audit catalog's id scheme while level 0 stays untouched."
rejected:
  - option: "b"
    why: "Core lint rules would make `chant lint` load workspace code and own a subject outside one project's source, which the ownership split (ws-027) gives to `workspace check`."
  - option: "c"
    why: "Ad hoc checks would produce findings without stable `WSP` ids or SARIF output."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D16. Audit, lint and checks"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d16-audit-lint-and-checks"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Declaration checks"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2535, member kinds from a data-only subpath, and WorkspaceCheck"
    url: "https://github.com/INTENTIUS/chant/issues/2535"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2535"
---

# Declaration checks
