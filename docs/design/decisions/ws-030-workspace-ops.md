---
schema: 1
id: "ws-030"
title: "Workspace Ops"
state: "decided"
area: "D17"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Workspace Ops (v8)"
  revision: "v8"
question: "When and how do Ops that span members run in a workspace?"
options:
  - id: "a"
    label: "`chant workspace run` with `<member>/<op>`, after #1939"
    how: "`chant workspace run` is the only way to run Ops that span members. OPS014 checks each `<member>/<op>` target against the composed graph. The work waits until #1939 lands checks across build roots."
    tradeoff: "`chant run` at a root keeps meaning the root's own Ops. Workspace Ops ship later, in phase 6."
  - id: "b"
    label: "root Ops in phase 1"
    how: "In phase 1, cross-member Ops live in the member holding the `workspace-ops` role (often `.`). They run with `chant workspace run <op>` and write their own `_workspace` ledger ref."
    tradeoff: "Workspace Ops arrive early. They would ship before chant can check anything across build roots."
    chosen_in: "v6"
  - id: "c"
    label: "none"
    how: "chant has no Ops that span members; each member runs only its own Ops."
    tradeoff: "Nothing to build. Release trains and other cross-member runs stay outside chant."
choice:
  option: "a"
  reason: "The choice was revised in v8 away from root Ops in phase 1, which v6 chose; the earlier choice is in the #2524 edit history. D17 waits for #1939 so that cross-member targets can be checked. It also leaves `chant run` at a root with the root's own Ops. The source is ambiguous because the v6 text placed these Ops in a `workspace-ops` member that was often `.`, so the label root Ops is a loose summary of it."
rejected:
  - option: "b"
    why: "Shipping in phase 1 would run cross-member Ops before #1939 gives checks across build roots."
  - option: "c"
    why: "Workspace pipelines and release trains (D19) need Ops that span members."
supersedes:
  - revision: "v6"
    option: "b"
evidence:
  - title: "INTENTIUS/chant#2524, D17. Workspace Ops"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d17-workspace-ops"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Workspace Ops (v8)"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#1939, a project-level, cross-build-root mode for post-synth checks"
    url: "https://github.com/INTENTIUS/chant/issues/1939"
    as_of: null
  - title: "INTENTIUS/chant#2554, workspace Ops, the workspace pipeline and release trains"
    url: "https://github.com/INTENTIUS/chant/issues/2554"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2554"
---

# Workspace Ops
