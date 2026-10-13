---
schema: 1
id: "ws-035"
title: "Audit bugs"
state: "decided"
area: "D0"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Audit bugs"
  revision: null
question: "Are the `chant audit` bugs fixed for every project, or only inside workspaces?"
options:
  - id: "a"
    label: "listed exceptions, goldens"
    how: "`chant audit` reports a truncated scan where today it stops silently at 1000 files. TF023 honors nested `.gitignore` files. Both fixes sit on #2525's exception list with a warning release, and CLI goldens pin the result."
    tradeoff: "Every project gets correct audits. Level 0 audit output changes and has to be announced ahead."
  - id: "b"
    label: "workspaces only"
    how: "The fixes apply only when a workspace declaration exists, and level 0 keeps today's output."
    tradeoff: "Level 0 output stays byte-identical. Plain projects keep silent truncation, and the same files audit differently depending on whether a declaration exists."
choice:
  option: "a"
  reason: "D0 permits a level 0 output change when it is listed and warned a release ahead, and CLI goldens enforce the list. These are bugs that plain projects hit too, so the fix belongs at level 0. The source is ambiguous because the v8 D-sections do not name the audit fixes and D16 says `chant audit` is unchanged. The choice rests on the v6 D0 text and #2525's exception list."
rejected:
  - option: "b"
    why: "Fixing only in workspaces would leave plain projects with silent truncation and make a declaration change audit results for the same files."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D0. Levels of use, all opt-in"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d0-levels-of-use-all-opt-in"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Audit bugs"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2525, the workspace driver and its exception list"
    url: "https://github.com/INTENTIUS/chant/issues/2525"
    as_of: null
  - title: "INTENTIUS/chant#2528, chant audit: report truncated scans and read nested .gitignore in TF023"
    url: "https://github.com/INTENTIUS/chant/issues/2528"
    as_of: null
  - title: "INTENTIUS/chant#2526, CLI golden tests that pin level-0 output"
    url: "https://github.com/INTENTIUS/chant/issues/2526"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2528"
  - "INTENTIUS/chant#2526"
---

# Audit bugs

See [the levels of use](../workspace-levels.md).
