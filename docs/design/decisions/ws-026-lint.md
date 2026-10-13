---
schema: 1
id: "ws-026"
title: "Lint"
state: "decided"
area: "D16"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Lint"
  revision: null
question: "How are members linted once their directories leave the root project?"
options:
  - id: "a"
    label: "`workspace lint` per member"
    how: "`chant workspace lint` runs each member's own `chant lint` under that member's toolchain. It merges the results, with one SARIF run per member."
    tradeoff: "Each member is linted exactly as it would be alone. The run starts one process per toolchain identity, so members that share a toolchain share a process."
  - id: "b"
    label: "root lint"
    how: "Top-level `chant lint` covers every member with the root's chant."
    tradeoff: "There is a single run. Members pinned to other versions get linted with rules they do not use."
  - id: "c"
    label: "nothing"
    how: "Nothing lints members at the top level. Each member is linted only when someone runs lint inside it."
    tradeoff: "No new code is needed. The coverage the top-level lint loses when members leave it is gone."
choice:
  option: "a"
  reason: "Declaring members takes them out of top-level `chant lint`, so the coverage has to come back somewhere. Each member keeps its own toolchain. Its own lint therefore knows its lexicon versions and overrides. One SARIF run per member keeps each finding tied to its member."
rejected:
  - option: "b"
    why: "The root's chant may not match a member's lexicons, so its findings could be wrong for that member."
  - option: "c"
    why: "Members would go unlinted unless someone ran lint inside each one."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D16. Audit, lint and checks"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d16-audit-lint-and-checks"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2537, per-member build, lint, audit and graph"
    url: "https://github.com/INTENTIUS/chant/issues/2537"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2537"
---

# Lint
