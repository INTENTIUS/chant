---
schema: 1
id: "lsn-001"
title: "Pin the spec before trusting a decision that cites it"
state: "confirmed"
source:
  kind: "workspace"
  member: "design"
situation: "ref-002 named design/screens/home.json as the home screen's spec, and W-001 was opened against it with no evidence pin. The app's home page and the spec drifted apart for a while with nothing in records --json to show it."
learned: "A decision or work item that governs a workspace file should pin it in evidence as soon as the file is stable, not only once the work is done. records reports asset-drift the moment the pinned file changes, and that is the earliest anyone would have noticed the spec had moved out from under the decision."
derived_from:
  - "ref-002"
  - "W-001"
confirmed_by: "lex00"
confirmed_on: "2026-09-25"
evidence: []
supersedes: []
---

# Pin the spec before trusting a decision that cites it

A decision or work item that names a workspace file as its spec should pin that file by hash as soon as it stops moving, not wait for the work to close. Waiting leaves a window where the spec can drift and nothing reports it.
