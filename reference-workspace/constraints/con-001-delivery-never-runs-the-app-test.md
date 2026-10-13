---
schema: 1
id: "con-001"
title: "The delivery member never runs the app member's own test"
state: "active"
source:
  kind: "workspace"
  member: "delivery"
rule: "The delivery member's chant project builds and lints the app's Dockerfile, but it never invokes the app's own node --test suite. The app runs its own tests, in its own directory, under its own toolchain."
constrains:
  - "member:delivery"
  - "member:app"
decided_by: "lex00"
decided_on: "2026-09-24"
evidence: []
---

# The delivery member never runs the app member's own test

Keeping the app's test inside the app member means the app can be tested on its own, whatever deploys it. This constraint holds until it is withdrawn: delivery may grow more checks of its own, but it does not take over the app's test.
