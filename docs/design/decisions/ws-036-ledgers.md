---
schema: 1
id: "ws-036"
title: "Ledgers"
state: "decided"
area: "D7"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Ledgers (v8)"
  revision: "v8"
question: "Where does each member's lifecycle ledger live, so two members that share an environment name stop overwriting each other?"
options:
  - id: "a"
    label: "`_members/<member>/` in the lifecycle branch"
    how: "Lifecycle stores move under `_members/<member>/` inside the existing `chant/lifecycle` branch, while the root `.` keeps today's flat layout."
    tradeoff: "Push and lease code keep working unchanged, and one commit can write to several members. Old chants below the floor keep the flat layout, so two of them sharing an environment name still collide."
  - id: "b"
    label: "refs"
    how: "Each member gets its own ref `refs/chant/lifecycle/<member>` outside `refs/heads`. The existing branch belongs to the member declared `ledger: legacy`."
    tradeoff: "It avoids the git clash of a ref under the existing branch name. Refs outside `refs/heads` need new push and lease code, and forge branch protection does not cover them."
    chosen_in: "v5"
  - id: "c"
    label: "branch per member"
    how: "Each member writes its ledger to its own lifecycle branch."
    tradeoff: "Members are fully separate and each can be protected. A change that touches several members needs one commit per member."
choice:
  option: "a"
  reason: "The choice was revised in v8 away from refs per member, which the table says v5 chose; the earlier choice is in the #2524 edit history. D7 keeps one lifecycle branch that forges already protect and CI already fetches. Member `.` keeps the flat layout, so level 0 stays byte-identical. The source is ambiguous because the v3 and v4 texts already chose refs per member, so the v5 label on that option looks late."
rejected:
  - option: "b"
    why: "Refs outside `refs/heads` would need new lifecycle code and fall outside the protection forges give the existing branch."
  - option: "c"
    why: "A branch per member cannot record a change to several members in one commit."
supersedes:
  - revision: "v5"
    option: "b"
evidence:
  - title: "INTENTIUS/chant#2524, D7. Ledgers"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d7-ledgers"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Ledgers (v8)"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2538, member ledgers under _members/ and unique ownership stacks"
    url: "https://github.com/INTENTIUS/chant/issues/2538"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2538"
  - "INTENTIUS/chant#2554"
---

# Ledgers
