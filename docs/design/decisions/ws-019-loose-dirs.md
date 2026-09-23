---
schema: 1
id: "ws-019"
title: "Loose dirs"
state: "decided"
area: "D11"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Loose dirs"
  revision: null
question: "Can behold still show directories that have no workspace declaration?"
options:
  - id: "a"
    label: "view free, save declares"
    how: "With no declaration, `behold serve <dir...>` stays a labelled, read-only level-0 view that uses behold's own composer. Saving a composition means writing a `chant.workspace.json`."
    tradeoff: "Anyone can look at a few directories without adopting a level. The viewer keeps a second composer for this case."
  - id: "b"
    label: "declared only"
    how: "Only directories with a declaration can be shown."
    tradeoff: "There is one composer. Looking at a few directories first requires writing a workspace."
  - id: "c"
    label: "keep all"
    how: "Loose views and `.behold.json` members both stay indefinitely beside declarations."
    tradeoff: "Current users see no change. Member lists stay in more than one place."
choice:
  option: "a"
  reason: "Level 0 must never pay, so viewing directories should need no declaration. The loose view is labelled and read-only so it never passes for a workspace. Saving it goes through the one declaration format."
rejected:
  - option: "b"
    why: "It would make users adopt level 1 just to look at directories, which breaks the rule that level 0 never pays."
  - option: "c"
    why: "It keeps a second member list alive, which the behold list decision (ws-015) deprecates."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D11. behold"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d11-behold"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, D0. Levels of use, all opt-in"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d0-levels-of-use-all-opt-in"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/behold#464"
    url: "https://github.com/INTENTIUS/behold/issues/464"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/behold#464"
---

# Loose dirs
