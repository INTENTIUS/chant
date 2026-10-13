---
schema: 1
id: "ws-024"
title: "Design app"
state: "decided"
area: "D18"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Design app (v8)"
  revision: "v8"
question: "Where do a design client and the artifacts it edits live in a workspace?"
options:
  - id: "a"
    label: "client member with lineage; separate `design` data member; assets pinned"
    how: "The client is a member with a `design-app` role and its own lineage. A separate `design` data member holds the artifacts, and records link to them by anchor and pin their hash when they close."
    tradeoff: "Upgrading the client never touches user work, and a closed record points at the exact version it judged. The workspace declares one more member."
  - id: "b"
    label: "artifacts inside the client"
    how: "The client member owns the artifacts in its own directory, and records pin them by hash."
    tradeoff: "There is one member fewer. The client's lineage scope, which upgrades write into, also holds user work."
    chosen_in: "v6"
  - id: "c"
    label: "nested workspace"
    how: "The app is always its own nested workspace inside the outer one."
    tradeoff: "Isolation is complete. The outer workspace can only read it, and only after phase 2."
  - id: "d"
    label: "siblings"
    how: "The app lives in a sibling workspace next to the product workspace."
    tradeoff: "Nothing is coupled. Records would pin assets across workspaces."
choice:
  option: "a"
  reason: "The choice was revised in v8 from artifacts inside the client (v6). An upgrade writes only inside its scope (D9), so artifacts kept in the client member sat where an upgrade writes. v8 moves them to a separate `design` data member, and the client keeps its role and its own lineage. The source is ambiguous because the v8 table drops options that v6 and v7 also rejected, among them artifacts as records, without giving a reason."
rejected:
  - option: "b"
    why: "v8 found that an upgrade of the client writes into the scope that held user work, so the artifacts moved to their own member."
  - option: "c"
    why: "A nested workspace is opaque in phases 1 and 2 and read-only after, which is more isolation than a client needs."
  - option: "d"
    why: "Records in the product workspace would have to pin assets held in another workspace."
supersedes:
  - revision: "v6"
    option: "b"
evidence:
  - title: "INTENTIUS/chant#2524, D18. Design apps"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d18-design-apps"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, D9. Templates and upgrade"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d9-templates-and-upgrade"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2549, record links, asset pins and the design data member"
    url: "https://github.com/INTENTIUS/chant/issues/2549"
    as_of: null
  - title: "INTENTIUS/chant#2550, migrations and chant workspace upgrade"
    url: "https://github.com/INTENTIUS/chant/issues/2550"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2549"
  - "INTENTIUS/chant#2550"
---

# Design app
