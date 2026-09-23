---
schema: 1
id: "ws-043"
title: "Releases"
state: "decided"
area: "D19"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Releases (v8)"
  revision: "v8"
question: "How are releases handled when a workspace has several members?"
options:
  - id: "a"
    label: "per member, compare view; trains later"
    how: "Releases stay per member, as an artifact digest plus a git SHA. `chant workspace status <env> --compare-to` is a read-only view across members, and release trains wait for workspace Ops."
    tradeoff: "No new release model now, and one view shows which release each member has where. Moving several members together stays manual until trains land."
  - id: "b"
    label: "train now"
    how: "A release-train record pins every member's release, and trains ship now."
    tradeoff: "Coordinated releases early. Trains need Ops that span members, which wait for #1939."
  - id: "c"
    label: "workspace promote"
    how: "One command promotes the whole workspace to an environment."
    tradeoff: "One step for users. Promote doesn't exist yet even for one project (#2530)."
choice:
  option: "a"
  reason: "A member's release is already a complete record in its own ledger, so keeping it per member costs nothing at level 1. The compare view answers the common question of what runs where without writing anything. Trains need workspace Ops, and a workspace promote needs promote and rollback for one project, which are filed as level-0 issues first (#2530, #2531). The row is new in v8. The source is ambiguous because v6 planned workspace Ops for phase 1 and gave releasing every member as its example of one, which is close to option b. The table lists no earlier choice for this row."
rejected:
  - option: "b"
    why: "Trains depend on workspace Ops, and those wait for #1939."
  - option: "c"
    why: "It would be built on promote and rollback, which chant lacks even for a single project."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D19. Delivery: CI, releases, environments"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d19-delivery-ci-releases-environments"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Releases (v8)"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2544, status and compare across members"
    url: "https://github.com/INTENTIUS/chant/issues/2544"
    as_of: null
  - title: "INTENTIUS/chant#2554, workspace Ops, the workspace pipeline and release trains"
    url: "https://github.com/INTENTIUS/chant/issues/2554"
    as_of: null
  - title: "INTENTIUS/chant#2530, promote a release to another environment without rebuilding"
    url: "https://github.com/INTENTIUS/chant/issues/2530"
    as_of: null
  - title: "INTENTIUS/chant#2531, roll an environment back to an earlier release from the ledger"
    url: "https://github.com/INTENTIUS/chant/issues/2531"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2544"
  - "INTENTIUS/chant#2554"
  - "INTENTIUS/chant#2530"
  - "INTENTIUS/chant#2531"
---

# Releases
