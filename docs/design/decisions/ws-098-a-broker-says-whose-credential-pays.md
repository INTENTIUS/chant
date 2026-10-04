---
schema: 1
id: "ws-098"
title: "A broker says whose credential pays"
state: "decided"
area: "D15"
source:
  issue: "INTENTIUS/chant#3474"
  row: "the broker protocol tells a box whose credential pays (payer: shared, owner or visitor)"
  revision: null
question: "How does a box learn whose credential its broker spends on its model calls, so that a surface on the box can bound what is spent on someone else's credential and stop bounding it once the person prompting pays?"
options:
  - id: "a"
    label: "an optional payer in version 1: a field on the declaration's answer and a chant-payer header on each inference and decide answer"
    how: "The broker adds payer, { kind: shared | owner | visitor, principal }, to the declarationKept answer of POST /api/box/declaration, and a chant-payer header, '<kind>' or '<kind> <principal>', to each answer it relays from /llm/anthropic and /decide. shared is a credential neither the box's owner nor its visitor owns, such as a house or operator key; owner is the box owner's own; visitor is the credential a person brought for this box. principal is that person in ws-080's form when the broker knows them. broker-protocol.ts adds BrokerPayer, PAYER_HEADER, formatPayerHeader, parsePayerHeader and payerOf; the schema adds $defs.payer. The conformance suite's payer-consistent check holds a broker that says a payer to a well-formed one, said on both channels and the same on both. A broker that says nothing still conforms, and a box reads silence as unknown."
    tradeoff: "Two channels to keep in step, which the check enforces. The report is answered every few minutes and the header on every call, so a box hears of a change at its next model call. An optional field means a box cannot tell an old broker from one that will not say, and must treat both as unknown."
  - id: "b"
    label: "a new route, GET /api/box/payer"
    how: "The box asks the broker whose credential pays when it needs to know."
    tradeoff: "One more route every broker serves and every box polls, for a fact the broker already has at the two moments it answers the box."
  - id: "c"
    label: "a version 2 of the protocol with the payer required"
    how: "Every answer carries the payer, and a version-1 broker no longer conforms."
    tradeoff: "Breaks studio's lobby and every other version-1 broker for a fact only one consumer reads today."
  - id: "d"
    label: "leave it to the surface: the box asks the person who pays"
    how: "hud asks the visitor whether they added their own token, or reads the broker's own pages."
    tradeoff: "Takes a person's word for a fact only the broker can know, and ties the box to one broker's pages."
choice:
  option: "a"
  reason: "The broker already holds the fact at the two moments it answers the box: when it takes the declaration, and when it relays a model call it has just chosen a credential for. Saying it there costs no new route, keeps every version-1 broker conformant, and gives arugula-salad/hud#416 what it needs to lift its guest bound only while the visitor's own credential pays. The principal lets a surface show who pays without a second lookup."
rejected:
  - option: "b"
    why: "It adds a route and a poll for a fact the existing answers can carry."
  - option: "c"
    why: "It breaks every version-1 broker for one consumer; the field can become required in a version 2 if more surfaces depend on it."
  - option: "d"
    why: "A box must not take a person's word for whose credential is spent; only the broker knows."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3474, the broker protocol tells a box whose credential pays"
    url: "https://github.com/INTENTIUS/chant/issues/3474"
    as_of: "2026-10-04T00:00:00Z"
  - title: "INTENTIUS/chant#3164, a broker protocol for box capabilities"
    url: "https://github.com/INTENTIUS/chant/issues/3164"
    as_of: "2026-10-04T00:00:00Z"
  - title: "arugula-salad/hud#416, bring your own token after the shared limit runs out"
    url: "https://github.com/arugula-salad/hud/issues/416"
    as_of: "2026-10-04T00:00:00Z"
  - title: "arugula-salad/hud#823, owner decisions, item 5: a guest's own credential stays in the lobby, never the box"
    url: "https://github.com/arugula-salad/hud/issues/823"
    as_of: "2026-10-04T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-04"
reviews: []
constrains:
  - "INTENTIUS/chant#3474"
  - "ws-097"
  - "arugula-salad/hud#416"
  - "member:core"
  - "path:packages/core/src/workspace/broker-protocol.ts"
  - "path:packages/core/src/workspace/broker-protocol.schema.json"
  - "path:packages/core/src/workspace/conformance/broker.ts"
---

# A broker says whose credential pays
