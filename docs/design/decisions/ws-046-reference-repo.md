---
schema: 1
id: "ws-046"
title: "Reference repo"
state: "decided"
area: "D21"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Reference repo (v8)"
  revision: "v8"
question: "When is the reference workspace built?"
options:
  - id: "a"
    label: "walking skeleton from phase 1"
    how: "A walking skeleton at level 1 is built in phase 1 and becomes chant's integration fixture. Each later phase lands its change in it."
    tradeoff: "Every change is tested against a real workspace from the start. Someone has to own the repo and keep it working throughout."
  - id: "b"
    label: "phase 6"
    how: "It is built last, in phase 6, from the finished features."
    tradeoff: "Built once against a settled design, but earlier work lands with nothing real to check it."
  - id: "c"
    label: "hand-built first"
    how: "Someone writes it by hand first, and chant is built to match it."
    tradeoff: "Gives an early target. Nothing checks it against chant until the features land, so it can drift from what ships."
choice:
  option: "a"
  reason: "As the integration fixture, the reference workspace checks each change on a real workspace as it lands. `chant init --from` on it has to produce a working workspace with a lock, which also exercises lineage early (#2543). Its README names the owner and tag schedule, and states the upgrade range and chant floor it supports. The source is ambiguous because v6 and v7 placed the reference repository in phase 6, outside core, which is option b. The table names no earlier choice for this row."
rejected:
  - option: "b"
    why: "Phases 1 to 5 would land with nothing real to try them on."
  - option: "c"
    why: "A hand-built repo has nothing checking it against chant, so it can drift from what ships."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D21. The reference workspace"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d21-the-reference-workspace"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Reference repo (v8)"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Phasing"
    url: "https://github.com/INTENTIUS/chant/issues/2524#phasing"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2543, the reference spec-and-skeleton workspace as a walking skeleton"
    url: "https://github.com/INTENTIUS/chant/issues/2543"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2543"
---

# Reference repo
