---
schema: 1
id: "ws-011"
title: "No-regression"
state: "decided"
area: "D0"
source:
  issue: "INTENTIUS/chant#2524"
  row: "No-regression"
  revision: null
question: "What does chant promise about level-0 output while workspace work lands?"
options:
  - id: "a"
    label: "listed, warned exceptions"
    how: "Level-0 output stays identical except for a changelogged list of changes, each warned one release ahead. CLI golden tests over the example projects enforce it."
    tradeoff: "Known bugs such as the fake SHA-256 digest can be fixed, with a release of warning. Every exception has to be listed and tracked in #2525."
  - id: "b"
    label: "strict bytes"
    how: "Level-0 output stays byte-identical, and any fix that changes it ships behind a flag."
    tradeoff: "The strongest promise. Bugs such as #2514 and #2519 would stay in default output."
  - id: "c"
    label: "plain semver"
    how: "Ordinary semantic versioning governs output changes, with no extra promise for level 0."
    tradeoff: "Least work to keep. Level-0 users get no specific guarantee that workspace work leaves their output alone."
choice:
  option: "a"
  reason: "D0's rule is that level 0 never pays, and golden tests make that checkable. A list of warned exceptions lets prerequisites such as #2514 and #2519 land without hiding them behind flags. The row was added in v5 together with D0."
rejected:
  - option: "b"
    why: "It would keep known bugs such as the fake SHA-256 digest in default output, or behind flags for good."
  - option: "c"
    why: "It gives level-0 users no specific promise, so workspace work could change their output without warning."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D0. Levels of use, all opt-in"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d0-levels-of-use-all-opt-in"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2525, the workspace driver and its exception list"
    url: "https://github.com/INTENTIUS/chant/issues/2525"
    as_of: null
  - title: "INTENTIUS/chant#2526, CLI golden tests that pin level-0 output"
    url: "https://github.com/INTENTIUS/chant/issues/2526"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2526"
  - "INTENTIUS/chant#2514"
  - "INTENTIUS/chant#2527"
  - "INTENTIUS/chant#2528"
  - "INTENTIUS/chant#2529"
---

# No-regression

See [the levels of use](../workspace-levels.md).
