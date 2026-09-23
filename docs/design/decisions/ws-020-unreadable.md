---
schema: 1
id: "ws-020"
title: "Unreadable"
state: "decided"
area: "D15"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Unreadable"
  revision: null
question: "What does a workspace listing do with a member it cannot read?"
options:
  - id: "a"
    label: "list and mark"
    how: "`ls` lists every member, and a member whose kind has no installed reader carries a reason code such as `unknown-kind` or `toolchain-too-old`. Only `workspace check` fails."
    tradeoff: "Readers always see the whole workspace and can explain each gap. A caller has to look at reason codes to notice a problem."
  - id: "b"
    label: "fail listing"
    how: "The listing fails when any member cannot be read."
    tradeoff: "A problem cannot be missed, but one missing plugin hides every other member."
choice:
  option: "a"
  reason: "A viewer should still show a workspace when one member's plugin or toolchain is missing, and the reason code tells it what to say. Failing closed stays with `workspace check`, which owns the declaration (D16)."
rejected:
  - option: "b"
    why: "One unreadable member would hide the rest, so a reader without one plugin could show nothing."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D15. Artifact and read contract"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d15-artifact-and-read-contract"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, D16. Audit, lint and checks"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d16-audit-lint-and-checks"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2536, the read contract, with output schemas, reason codes and --at"
    url: "https://github.com/INTENTIUS/chant/issues/2536"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2536"
  - "INTENTIUS/chant#2534"
---

# Unreadable
