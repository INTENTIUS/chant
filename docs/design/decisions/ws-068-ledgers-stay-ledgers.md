---
schema: 1
id: "ws-068"
title: "chant's lifecycle ledgers stay ledgers, not record kinds"
state: "decided"
area: "D5"
source:
  issue: "INTENTIUS/chant#2548"
  row: "chant's ledgers"
  revision: null
question: "#2524 D5 leaves open, for phase 3c, whether chant's own lifecycle ledgers become record kinds: the release, gate, run, converge, plan, build and lease ledgers chant writes on the chant/lifecycle branch (D7). Do they?"
options:
  - id: "a"
    label: "they stay ledgers: append-only files on chant/lifecycle, read through the read contract"
    how: "The ledgers keep their formats and their place under _members/<member>/ on chant/lifecycle (D7, ws-055). Readers get them through the read contract, as workspace status and work history already return them, and D4's rule for off-tree stores applies: append-only, with the tip anchored to an attested record when a gate needs it. Write scope (ws-067) covers the working tree; the branch is protected by the forge, as D7 says. A record kind can still cite a ledger entry by its digest, as a release record names a plan digest today."
    tradeoff: "No migration, and no level-0 change: a plain project's ledgers stay byte for byte (D7, member .). Ledger entries get no schema-validated read through records, no supersession and no reviews, which they don't need: an entry is a fact about a run, never revised."
  - id: "b"
    label: "each ledger becomes a record kind"
    how: "Release, gate, run and the rest get kind files and schemas; each entry is a record, read by chant workspace records with states, supersession and seals."
    tradeoff: "One reader for everything. It puts an append-only event log through a model built for reviewed documents with states, every run would be a record write subject to write scope and review, and moving the files changes what level 0 writes."
  - id: "c"
    label: "a record kind over the ledgers, read-only"
    how: "Ledgers stay as they are, and a derived record kind presents their entries through records --json."
    tradeoff: "One query surface. It duplicates what status and work history already return, and D4 says derived agent data is a record kind or a declared cache, so it adds a cache to keep in step."
choice:
  option: "a"
  reason: "A ledger entry records that something happened, written by a run and never changed, while a record is a document people propose, review, supersede and seal. D7 already places the ledgers where forges protect them and level 0 keeps its bytes, and ws-055 keeps coordination such as leases off the working branch so it stays outside release and write-scope checks. The read contract already serves them, so a record kind would add a second path to the same data."
rejected:
  - option: "b"
    why: "It puts run output through review, supersession and write scope it doesn't need, and moving the files would change level-0 output."
  - option: "c"
    why: "status and work history already return the ledgers through the read contract, and a derived kind would be a cache to keep in step."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D5 (chant's ledgers) and D7. Ledgers"
    url: "https://github.com/INTENTIUS/chant/issues/2524"
    as_of: "2026-09-30T00:00:00Z"
  - title: "INTENTIUS/chant#2548, audit of 2026-09-30: no decision on whether chant's ledgers become record kinds"
    url: "https://github.com/INTENTIUS/chant/issues/2548"
    as_of: "2026-09-30T00:00:00Z"
  - title: "ws-055, What a development model tracks goes in the workspace's ledgers"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-055-dev-model-ledgers.md"
    as_of: "2026-09-30T00:00:00Z"
  - title: "ws-067, Write scope and agent sessions"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-067-write-scope-and-agent-sessions.md"
    as_of: "2026-09-30T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-09-30"
reviews: []
constrains:
  - "INTENTIUS/chant#2548"
  - "path:packages/core/src/lifecycle"
---

# chant's lifecycle ledgers stay ledgers, not record kinds

This settles the open question in #2524 D5 and its Decisions section. The ledgers and their places are in [Workspace Declaration, Ledgers](https://intentius.io/chant/reference/workspace-declaration/#ledgers).
