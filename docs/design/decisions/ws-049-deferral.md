---
schema: 1
id: "ws-049"
title: "Deferral"
state: "decided"
area: "phasing"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Deferral (v8)"
  revision: "v8"
question: "Should items the v8 audit found premature be dropped from the plan?"
options:
  - id: "a"
    label: "nothing deferred; all kept in phases"
    how: "Every item stays in the plan, placed in a phase. Anything not ready waits on its prerequisites, such as workspace Ops waiting for #1939."
    tradeoff: "Nothing is lost and every item has an issue. The plan stays long, and later phases carry work that may change before it starts."
  - id: "b"
    label: "defer premature items"
    how: "Premature work leaves the plan until a need appears."
    tradeoff: "A shorter plan now. Dropped work loses its place in the order and has to be designed again when it returns."
choice:
  option: "a"
  reason: "Each item already has a phase and an issue under #2525, and ordering by phase keeps later work from blocking earlier work. Work above level 1 waits on ratification in any case (#2525), so keeping an item in a later phase commits nothing early. The row is new in v8. The source is ambiguous because no D-section states this choice and the table doesn't name the premature items, while #2525 still lets a child be deferred with a reason."
rejected:
  - option: "b"
    why: "Phasing already holds back work that isn't ready, and dropping it would lose its issue and its place in the order."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, Phasing"
    url: "https://github.com/INTENTIUS/chant/issues/2524#phasing"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Deferral (v8)"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2525, driver: workspaces in levels of use, all opt-in"
    url: "https://github.com/INTENTIUS/chant/issues/2525"
    as_of: null
  - title: "INTENTIUS/chant#1939, design: a project-level, cross-build-root mode for build-level post-synth checks"
    url: "https://github.com/INTENTIUS/chant/issues/1939"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2525"
---

# Deferral
