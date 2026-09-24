---
schema: 1
id: "ref-002"
title: "Where the screen design lives"
state: "decided"
area: "design"
source:
  issue: "INTENTIUS/chant#2543"
  row: "Where the screen design lives"
  revision: null
question: "Which member holds the spec and wireframe for the app's home screen?"
options:
  - id: "a"
    label: "the design data member"
    how: "`design/screens/` holds the screen spec and its wireframe. The app implements the spec, and the design client edits it."
    tradeoff: "Upgrading the design client never touches the design, and records can pin the files once #2549 lands. The app reads its spec from another member."
  - id: "b"
    label: "inside the app"
    how: "The app keeps its screen spec next to its code."
    tradeoff: "The spec sits beside what implements it. The design client would edit files inside the product's own member."
  - id: "c"
    label: "inside the design client"
    how: "The client stores the designs it edits in its own directory."
    tradeoff: "No extra member. The client's lineage scope, which an upgrade writes into, would hold user work."
choice:
  option: "a"
  reason: "This follows ws-024: artifacts live in a `design` data member so an upgrade of the client, which writes only inside the client's scope, cannot overwrite them."
rejected:
  - option: "b"
    why: "The design client would have to write into the product's member to edit a screen."
  - option: "c"
    why: "An upgrade of the client writes into the directory that would hold the designs, which ws-024 rules out."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D18. Design apps"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d18-design-apps"
    as_of: "2026-09-24T01:50:08Z"
  - title: "ws-024, Design app"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-024-design-app.md"
    as_of: "2026-09-24T01:50:08Z"
  - title: "The home screen spec"
    path: "design/screens/home.json"
    sha256: "074e55f524703fe65ecba4cf0e2cd3200e21f969a1f789618e22ff9537dd99e0"
    as_of: "2026-09-24T12:00:00Z"
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "member:app"
  - "member:design"
  - "member:design-client"
---

# Where the screen design lives
