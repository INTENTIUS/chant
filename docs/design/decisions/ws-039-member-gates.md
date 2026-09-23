---
schema: 1
id: "ws-039"
title: "Member gates"
state: "decided"
area: "D17"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Member gates (v8)"
  revision: "v8"
question: "Can a workspace gate stand in for a member's own gate?"
options:
  - id: "a"
    label: "never now, opt-in with digest coverage later"
    how: "For now a workspace gate never satisfies a member gate. Later a member can opt in at base to accept one, provided the workspace plan digest covers the member's own."
    tradeoff: "Members keep their own sign-off until digest coverage exists. After that, a member can choose to accept one decision for a change across members."
  - id: "b"
    label: "never"
    how: "Each member always approves its own plan, whatever the workspace approved."
    tradeoff: "The simplest rule to check. A release across many members needs one approval per member for good."
  - id: "c"
    label: "always"
    how: "A passed workspace gate counts for every member."
    tradeoff: "One sign-off moves every member. The approver may never have seen a member's plan, so nothing ties the decision to what that member applies."
choice:
  option: "a"
  reason: "An approval binds to a plan digest (threat model), so a workspace gate can stand in for a member's only when its digest covers the plan the member will apply. Until that coverage exists the rule is never. The later opt-in is read from base like other policy, so the member's owners decide it. The row is new in v8; v6 and v7 had member records cite the workspace run but stated no rule on this."
rejected:
  - option: "b"
    why: "It rules out a safe shortcut permanently. Once the workspace digest covers the member's, a second approval adds nothing."
  - option: "c"
    why: "It breaks the rule that an approval binds to the plan the approver saw."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D17. Workspace Ops"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d17-workspace-ops"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Member gates (v8)"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Threat model"
    url: "https://github.com/INTENTIUS/chant/issues/2524#threat-model"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2554, workspace Ops, the workspace pipeline and release trains"
    url: "https://github.com/INTENTIUS/chant/issues/2554"
    as_of: null
  - title: "INTENTIUS/chant#2300, a gate resolution binds nothing about the plan it approved"
    url: "https://github.com/INTENTIUS/chant/issues/2300"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2554"
---

# Member gates
