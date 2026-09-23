---
schema: 1
id: "ws-034"
title: "Walker"
state: "decided"
area: "D0"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Walker"
  revision: null
question: "How do chant's four discovery walkers become one?"
options:
  - id: "a"
    label: "converge at once, all listed"
    how: "One walker serves every command, and every difference between today's walkers converges in one change. Each behavior change is on #2525's exception list, warned one release ahead."
    tradeoff: "Level 0 output changes once, with every difference named in advance. That one change is large, and users may need globs to keep today's behavior."
  - id: "b"
    label: "converge later"
    how: "The walkers share code now, and their behavior converges over later releases."
    tradeoff: "Each release changes less. Level 0 output would change several times, and member exclusion would land on walkers that still disagree."
  - id: "c"
    label: "partial"
    how: "Only the dot-directory and git-ignore differences are unified; the other differences stay."
    tradeoff: "The smallest change to level 0. Project boundaries and the source-root quirk would still differ per command."
choice:
  option: "a"
  reason: "D0 allows level 0 output to change only through listed exceptions warned a release ahead. Converging every difference at once keeps that to one listed change. D2 excludes member directories when discovering member `.`, and that only works if all four commands agree on where a boundary is. The source is ambiguous because the v8 D-sections do not state this choice. It rests on the v6 D0 text and #2525's exception list."
rejected:
  - option: "b"
    why: "Each later step would be another level 0 change needing its own warning release."
  - option: "c"
    why: "Unifying only dot-directories and ignored files leaves project boundaries and the source-root quirk different per command, so builds of multi-project directories would still skip projects."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D0. Levels of use, all opt-in"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d0-levels-of-use-all-opt-in"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, What exists"
    url: "https://github.com/INTENTIUS/chant/issues/2524#what-exists"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Walker"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2525, the workspace driver and its exception list"
    url: "https://github.com/INTENTIUS/chant/issues/2525"
    as_of: null
  - title: "INTENTIUS/chant#2519, discovery imports every .ts file in the project"
    url: "https://github.com/INTENTIUS/chant/issues/2519"
    as_of: null
  - title: "INTENTIUS/chant#2527, converge the build, lint, Op and audit discovery walkers"
    url: "https://github.com/INTENTIUS/chant/issues/2527"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2527"
  - "INTENTIUS/chant#2519"
  - "INTENTIUS/chant#2526"
---

# Walker

See [the levels of use](../workspace-levels.md).
