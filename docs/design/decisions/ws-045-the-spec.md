---
schema: 1
id: "ws-045"
title: "The spec"
state: "decided"
area: "D20"
source:
  issue: "INTENTIUS/chant#2524"
  row: "The spec (v8)"
  revision: "v8"
question: "What makes up a workspace's spec, and how do readers get it?"
options:
  - id: "a"
    label: "current spec-kind records plus a query"
    how: "Current (not superseded) records of kinds a plugin marks `spec: true`, plus the assets they pin, make up the spec. `chant workspace records --current --json` returns it as part of the read contract."
    tradeoff: "Each record is validated and sealed on its own, and any reader can run the query. Reading the whole set needs the query or the record files."
  - id: "b"
    label: "one sealed document"
    how: "One document, sealed as a whole."
    tradeoff: "One hash to cite. Any change reseals everything, and no part can be superseded on its own."
  - id: "c"
    label: "prose"
    how: "Prose docs hold it."
    tradeoff: "Easy to write. Nothing validates it, and agents and readers can't query it."
choice:
  option: "a"
  reason: "Records already carry schemas, seals and derived supersession (D4), so a spec made of records gets all three. Agents resume from the query (D20), and hud reads it the same way. Schemas and a conformance suite for the format live in chant. The row is new in v8. The source is ambiguous because v6 and v7 called the phase-6 reference repository both the spec and the skeleton, and the framing still does; the table doesn't say whether that was an earlier choice among these options."
rejected:
  - option: "b"
    why: "A single sealed document can't have parts superseded one at a time, which D4 derives per record."
  - option: "c"
    why: "Prose can't be validated or sealed, and agents can't query it."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D20. The spec and agents"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d20-the-spec-and-agents"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row The spec (v8)"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, D4. Records"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d4-records"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2546, records, seals and the spec query (phase 3a)"
    url: "https://github.com/INTENTIUS/chant/issues/2546"
    as_of: null
  - title: "INTENTIUS/chant#2536, the read contract, with output schemas, reason codes and --at"
    url: "https://github.com/INTENTIUS/chant/issues/2536"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2546"
  - "INTENTIUS/chant#2536"
---

# The spec
