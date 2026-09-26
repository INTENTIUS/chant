---
schema: 1
id: "pref-001"
title: "New decisions default to the workspace source, not an issue row"
state: "active"
source:
  kind: "workspace"
  member: "design"
default: "A new decision in this workspace is written with source.kind \"workspace\" unless a real issue already has the row it comes from."
rationale: "Most decisions here come up while working in the workspace itself, not from a tracked issue's decisions table. Naming an issue that does not really hold the row is worse than saying plainly that the workspace is the source."
chosen_by: "lex00"
chosen_on: "2026-09-24"
evidence: []
---

# New decisions default to the workspace source, not an issue row

This is a default, not a rule: a decision that does come from a tracked issue's table still uses the issue form of source, and nothing here stops it.
