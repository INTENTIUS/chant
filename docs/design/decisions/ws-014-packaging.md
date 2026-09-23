---
schema: 1
id: "ws-014"
title: "Packaging"
state: "decided"
area: "D0"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Packaging"
  revision: null
question: "Where does the workspace code ship, and when does it load?"
options:
  - id: "a"
    label: "core, lazy"
    how: "Workspace code is part of `@intentius/chant`. It loads only when a workspace declaration or lock file is present or a `chant workspace` command runs, and kinds and attestors come from plugins."
    tradeoff: "Users keep one package with one version. A plain project pays no load cost, though core grows by the size of this code."
  - id: "b"
    label: "separate package"
    how: "Workspace code ships as its own npm package that users install next to chant."
    tradeoff: "Core stays smaller. In exchange, two packages have to stay at matching versions."
  - id: "c"
    label: "split"
    how: "Level 1 lives in core, while the upper levels ship as separate packages."
    tradeoff: "Upper levels install only when used. Their packages must each agree with the core version."
choice:
  option: "a"
  reason: "Lazy loading already keeps level 0 free, and a test checks that no workspace module loads in a level-0 build (#2526). Keeping the code in core leaves a single package to version. Kinds and attestors, the parts that vary by use, are plugins in any case."
rejected:
  - option: "b"
    why: "It adds a package whose version must match chant's. Lazy loading already keeps workspace code out of a level-0 run."
  - option: "c"
    why: "Record kinds and attestors already arrive as plugins. Splitting the levels would add packages to keep in step while saving level 0 nothing."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D0. Levels of use, all opt-in"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d0-levels-of-use-all-opt-in"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2525, level-0 rules"
    url: "https://github.com/INTENTIUS/chant/issues/2525"
    as_of: null
  - title: "INTENTIUS/chant#2526, CLI golden tests that pin level-0 output"
    url: "https://github.com/INTENTIUS/chant/issues/2526"
    as_of: null
  - title: "INTENTIUS/chant#2534, the declaration and chant workspace init"
    url: "https://github.com/INTENTIUS/chant/issues/2534"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2534"
  - "INTENTIUS/chant#2535"
  - "INTENTIUS/chant#2526"
  - "INTENTIUS/chant#2547"
---

# Packaging

See [the levels of use](../workspace-levels.md).
