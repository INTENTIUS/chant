---
schema: 1
id: "W-002"
title: "The app's test checks the home page against the spec"
state: "open"
implements: []
needs:
  - "W-001"
constrains:
  - "path:design/screens/home.json"
  - "path:app/test"
evidence: []
opened_on: "2026-09-24"
source:
  kind: "workspace"
  member: "app"
supersedes: []
---

# The app's test checks the home page against the spec

Once the app renders the home page from `design/screens/home.json` (W-001), its test can read the same spec and check that every region it lists is on the page. A later edit to the spec that the app does not follow then fails the test.
