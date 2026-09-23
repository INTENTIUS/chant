---
schema: 1
id: "ws-010"
title: "Roster"
state: "decided"
area: "D13"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Roster"
  revision: null
question: "What entry shape do ops kits and workspace plugins use, given the roster of #2507?"
options:
  - id: "a"
    label: "shared entry shape"
    how: "Each entry uses the #2507 shape, with set-valued `supplies`, in its own roster file. Origin stays in each workspace's lock."
    tradeoff: "Tools read one shape while the rosters stay apart. Domain entries have to be told apart by what they supply."
  - id: "b"
    label: "one roster"
    how: "A single roster holds every entry. A type field or a second axis tells them apart."
    tradeoff: "One file to search. Domain ops kits could be mistaken for the language kits of #2507."
  - id: "c"
    label: "separate shapes"
    how: "Each sort of roster entry gets its own shape."
    tradeoff: "Each shape can change on its own. Readers need a parser per shape, and requirement B2 asks for a shared one."
choice:
  option: "a"
  reason: "Requirement B2 asks for a roster shape shared with ops kits, and D13 keeps a member's kind apart from its origin. A shared shape in separate files meets B2. A domain entry is told apart by its set-valued `supplies` (for example `supplies: [template]`), so it isn't mistaken for a language kit. Origin is recorded in each workspace's lock, where lineage lives. The source is ambiguous because #2524 gives no reasons for rejecting the two alternatives. The reasons here are derived from B2 and D13."
rejected:
  - option: "b"
    why: "Mixing domain entries with #2507's language kits in one list invites confusing the two."
  - option: "c"
    why: "It breaks the shared shape that B2 asks for."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D13. Kind is not origin"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d13-kind-is-not-origin"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2507, what has to generalize before there is more than one ops kit"
    url: "https://github.com/INTENTIUS/chant/issues/2507"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2507"
  - "INTENTIUS/chant#2540"
---

# Roster
