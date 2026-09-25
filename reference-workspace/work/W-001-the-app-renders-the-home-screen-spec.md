---
schema: 1
id: "W-001"
title: "The app renders the home screen from its spec"
state: "in-progress"
implements:
  - "ref-002"
needs: []
constrains:
  - "path:design/screens/home.json"
  - "member:app"
evidence: []
owner: "lex00"
opened_on: "2026-09-24"
source:
  finding: "intent-decision-unimplemented"
  region: "design/screens/home.json"
  decision: "ref-002"
supersedes: []
---

# The app renders the home screen from its spec

ref-002 puts the home screen's spec in the design member, and the app is to implement it. Today the app's home page follows `design/screens/home.json` only by a comment: the header and the status line are written out in `app/src/server.mjs`.

The work is done when the app builds its home page from the regions the spec lists, and the evidence pins the spec at the hash the app was checked against.
