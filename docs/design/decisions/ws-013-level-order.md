---
schema: 1
id: "ws-013"
title: "Level order"
state: "decided"
area: "D0"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Level order"
  revision: null
question: "Must the levels of use be adopted in order, or can a project skip some?"
options:
  - id: "a"
    label: "by dependency"
    how: "Levels depend on each other only where they must. Lineage works for a plain project with its lock at the project root, while records, links and signing need a declaration because their plugins are pinned there."
    tradeoff: "`chant init --template` projects can be upgraded without becoming workspaces. Each real dependency between levels has to be stated and tested."
  - id: "b"
    label: "strict ladder"
    how: "Each level requires every level below it."
    tradeoff: "Fewer combinations to support. A plain project could never get template upgrades."
  - id: "c"
    label: "fully independent"
    how: "Every level works alone, with no dependency on any other."
    tradeoff: "Any combination is allowed. Records and signing would have nowhere to pin their plugins without a declaration."
choice:
  option: "a"
  reason: "Tying levels together only where a real dependency exists lets a plain project use lineage, which the lock written at init in phase 1 builds on. Records, links and signing keep their need for a declaration, because that is where their plugins are pinned. The row was added in v5 as \"Skipping levels\"."
rejected:
  - option: "b"
    why: "Projects that only want template upgrades would have to take on records and signing first."
  - option: "c"
    why: "Records, links and signing need the declaration to pin their plugins."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D0. Levels of use, all opt-in"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d0-levels-of-use-all-opt-in"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2525, the workspace driver and its rules"
    url: "https://github.com/INTENTIUS/chant/issues/2525"
    as_of: null
  - title: "INTENTIUS/chant#2540, write the lineage lock at init"
    url: "https://github.com/INTENTIUS/chant/issues/2540"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2540"
  - "INTENTIUS/chant#2550"
---

# Level order

See [the levels of use](../workspace-levels.md).
