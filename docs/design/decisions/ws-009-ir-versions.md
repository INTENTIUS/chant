---
schema: 1
id: "ws-009"
title: "IR versions"
state: "decided"
area: "D8"
source:
  issue: "INTENTIUS/chant#2524"
  row: "IR versions"
  revision: null
question: "How does chant add a composed workspace IR without breaking consumers of `chant graph`?"
options:
  - id: "a"
    label: "split by command"
    how: "`chant graph` stays the single-project IR for good and changes only additively after gaining a `version` field. `chant workspace graph` is the composed IR from the day it ships."
    tradeoff: "No default ever flips, so saved layouts keep working. An old chant fails `workspace graph` with \"unknown command\", and readers must explain that."
  - id: "b"
    label: "flag and flip"
    how: "Consumers ask for v2 with `--ir 2`, and v2 becomes the default once behold's composer reads it."
    tradeoff: "One command covers both shapes. Any consumer that doesn't pass the flag sees different output on the release that flips it."
  - id: "c"
    label: "flag only"
    how: "An `--ir` flag selects the version, and the default never flips."
    tradeoff: "Nothing changes for existing consumers. The flag stays on a project command for good, and the composed IR is always opt-in there."
choice:
  option: "a"
  reason: "Splitting by command means no release changes what an existing command prints, which the D0 no-regression rule needs. The composer reads each member through its own `chant graph` and upgrades v1 output in place, so members on old chants still appear. The v6 table records this choice as revised in v5 from the v4 decision, a flag with a later default flip. The source is ambiguous because the current table gives this row no revision marker and marks no option as the earlier choice, so the v4 choice of \"flag and flip\" is missing from `supersedes`."
rejected:
  - option: "b"
    why: "Flipping the default would change `chant graph` output for level-0 users, which D0 forbids."
  - option: "c"
    why: "It keeps a permanent flag on a project command for output that belongs to the workspace command."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D8. IR"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d8-ir"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2529, chant graph: add a version field and reserve the workspace command name"
    url: "https://github.com/INTENTIUS/chant/issues/2529"
    as_of: null
  - title: "INTENTIUS/chant#2537, per-member build, lint, audit and graph"
    url: "https://github.com/INTENTIUS/chant/issues/2537"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2529"
  - "INTENTIUS/chant#2537"
  - "INTENTIUS/behold#464"
---

# IR versions
