---
schema: 1
id: "ws-064"
title: "Decision kind for a plugin"
state: "decided"
area: "D4"
source:
  issue: "INTENTIUS/chant#2555"
  row: "Decision kind for a plugin"
  revision: null
question: "#2555 asks for a decision record kind specified for the development-model plugin on the core record contract of #2546, and #2525 puts that plugin outside core. Now that the record contract is final, what does chant ship so a plugin can carry the kind, and does chant build the plugin?"
options:
  - id: "a"
    label: "chant's kind file is the specification, and a plugin carries a copy"
    how: "docs/design/decisions/decision.kind.mjs and decision.schema.json stay in the chant repo as the specification, both data only. A reference page states the kind against the core record contract: its states and closed states, the seal field closed_digest, spec: true, the review digest and the quorum, and which kind keys use which part of the contract. A plugin, or any workspace, carries the kind by copying both files unchanged except for the comments, declares the copy by path in its chant.workspace.json, keeps the name decision and the schema id urn:intentius:chant:decision:1, and runs a test that its recordKind and schema equal chant's, as test/reference-workspace.test.ts already does for the reference workspace's copy."
    tradeoff: "Nothing new in core and no plugin to build. A plugin's copy can fall behind chant's, and only a test in the plugin catches it. A schema change is a chant change that each copy then follows."
  - id: "b"
    label: "build the development-model plugin now and move the kind into it"
    how: "Start the plugin package, move the kind file and the schema into it, and have the chant repo and the reference workspace read the kind from the plugin."
    tradeoff: "One home for the kind. The plugin is outside core under #2525, nothing else it would hold exists yet, and a workspace names a record kind by a path inside itself, so chant's own repo would need the plugin installed to read its decisions."
  - id: "c"
    label: "a built-in decision kind in core"
    how: "Core ships the decision kind, and every workspace reads decisions without declaring a kind."
    tradeoff: "No copies. It puts a domain kind in core, which #2524 D3 and ws-031 rejected, and ties each change to the decision schema to a chant release."
choice:
  option: "a"
  reason: "The kind file is already data that core reads through the record contract with no decision-specific code, except that box intents look for a declared kind named decision (#2850). Stating that contract on one reference page is what the criterion asks for, and the reference workspace already shows the copy and the drift test working. Building the plugin is outside core (#2525), and moving the kind before the plugin exists would leave chant's own decisions unreadable without it."
rejected:
  - option: "b"
    why: "The plugin is outside core and has nothing else to hold yet, and chant's decisions would depend on a package chant does not ship."
  - option: "c"
    why: "Core ships no domain kinds (#2524 D3, ws-031), and the decision schema would move only with chant releases."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2555, decision records and their review in hud, audit of 2026-09-30"
    url: "https://github.com/INTENTIUS/chant/issues/2555"
    as_of: "2026-09-30T00:00:00Z"
  - title: "ws-063, Seal and review digest"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-063-seal-and-review-digest.md"
    as_of: "2026-09-30T00:00:00Z"
  - title: "ws-031, Plugin shape"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-031-plugin-shape.md"
    as_of: "2026-09-30T00:00:00Z"
  - title: "INTENTIUS/chant#2525, driver: workspaces in levels of use"
    url: "https://github.com/INTENTIUS/chant/issues/2525"
    as_of: "2026-09-30T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-09-30"
reviews: []
constrains:
  - "INTENTIUS/chant#2555"
  - "path:docs/design/decisions/decision.kind.mjs"
  - "path:reference-workspace/decisions/decision.kind.mjs"
---

# Decision kind for a plugin

The specification is [Decision Record Kind](https://intentius.io/chant/reference/decision-kind/). A copy of the kind keeps its name, its schema id and its data, and tests that against chant's files.
