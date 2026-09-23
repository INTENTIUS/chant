---
schema: 1
id: "ws-025"
title: "Audit"
state: "decided"
area: "D16"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Audit"
  revision: null
question: "What does `chant audit` do at a workspace root?"
options:
  - id: "a"
    label: "unchanged plus `workspace audit`"
    how: "`chant audit` stays as it is and scans the directory it is given, so at a root it already covers every member. `chant workspace audit` runs audit per member with each `.chant-audit.json` and adds a `member` field to every finding."
    tradeoff: "Level-0 audit output is unchanged, and per-member settings apply when asked for. Users have one more command to learn, which is the cost."
  - id: "b"
    label: "auto mode"
    how: "When it finds a declaration, `chant audit` switches to a per-member mode by itself."
    tradeoff: "Users keep one command. Its output changes, though, as soon as someone adds a declaration."
  - id: "c"
    label: "flag"
    how: "A flag on `chant audit` turns on the per-member mode, and the default stays as it is."
    tradeoff: "No new command is needed. A project command then has to load workspace code, which level 0 avoids."
choice:
  option: "a"
  reason: "`chant audit` never needed a project and already covers every member at a root, so it can stay as it is. Per-member settings go through `chant workspace audit`, which keeps workspace behaviour under the `chant workspace` commands (D12)."
rejected:
  - option: "b"
    why: "Adding a declaration would change what `chant audit` prints, and D0 says project commands keep project meaning."
  - option: "c"
    why: "It puts workspace behaviour into a project command when the per-member view fits under `chant workspace`."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D16. Audit, lint and checks"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d16-audit-lint-and-checks"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, D12. Commands and words"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d12-commands-and-words"
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

# Audit
