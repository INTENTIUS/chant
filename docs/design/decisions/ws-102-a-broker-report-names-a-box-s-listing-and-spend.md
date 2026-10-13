---
schema: 1
id: "ws-102"
title: "A broker report names a box's listing and spend"
state: "decided"
area: "D17"
source:
  issue: "INTENTIUS/chant#3508"
  row: "name listing and spend in the broker protocol's declaration report (arugula-salad/studio#394)"
  revision: null
question: "Studio's steward sends two fields beyond ws-097's { capabilities } in its declaration report, the box's listing and the month's spend from its run records, and studio's lobby checks and keeps them (arugula-salad/studio#369, #384). Does the broker protocol name them, and if so in what shape?"
options:
  - id: "a"
    label: "name listing and spend as optional fields of the report, in the shapes the lobby already checks"
    how: "declarationReport gains listing, the box block's listing (ws-077) less the cover as { published, title, line } with the bounds box listing set writes with, and spend, the month's figures from the run records (ws-076) as { month, usd, runs, unpriced, byPrincipal: [{ principal, usd, runs, unpriced }] }, USD only, a run with no USD cost counted as unpriced and never as zero, at most 50 principals. Both are optional in version 1. A broker that has no use for them ignores them; one that keeps them echoes them on declarationKept and refuses a malformed one with a 400. parseDeclarationReport checks them as the lobby does, spendFromRuns computes spend from chant workspace runs --json, and the conformance suite sends a report carrying both and expects a 200."
    tradeoff: "A second broker, or a second steward, gets a contract for what studio already sends, and the conformance suite exercises it. The protocol carries two fields only listing hosts and spend reporters use, which a minimal broker has to ignore, as it already ignores unknown fields."
  - id: "b"
    label: "leave them as studio's extra fields outside the protocol"
    how: "The report stays { capabilities }; studio's steward and lobby keep agreeing on listing and spend between themselves, as unknown fields every other broker ignores."
    tradeoff: "Nothing changes in chant. Any other broker or steward that wants to list a box or report its spend reverse-engineers studio's code, and nothing checks that two implementations agree."
  - id: "c"
    label: "carry them on separate routes"
    how: "POST /api/box/listing and POST /api/box/spend, each with its own body, beside the declaration report."
    tradeoff: "Each fact has its own route and its own refusal. A steward makes three calls where it makes one, and a broker tracks three reports per box where the lobby already keeps one record replaced as a whole."
choice:
  option: "a"
  reason: "Both facts already travel in the report, and the lobby checks them there, so naming them writes down a contract that exists rather than designing a new one. They are the repository's facts, the listing in the box block (ws-077) and the spend in the run ledger (ws-076), and ws-074 makes the broker's copy a cache, which the report already is: each one replaces the last. Keeping them optional means no broker has to change, and the shapes are the lobby's own so studio's steward and lobby need no change either. Separate routes (option c) would add calls and records for facts that change at the same time the report is resent. Spend stays what the run records say, USD per principal plus an unpriced count; signing it, so a broker can trust the figure rather than the box's word, is the separate signed-spend work in studio#394 with chant#3192's statements."
rejected:
  - option: "b"
    why: "It leaves two facts studio already depends on without a contract, so a second broker or steward can only copy studio's code, and the conformance suite never sends them."
  - option: "c"
    why: "Three calls and three cached records per box for facts that are sent together, with nothing gained over one report replaced as a whole."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3508, name listing and spend in the broker protocol's declaration report"
    url: "https://github.com/INTENTIUS/chant/issues/3508"
    as_of: "2026-10-04T00:00:00Z"
  - title: "arugula-salad/studio#394, the lobby's own facts and what moves into the repository"
    url: "https://github.com/arugula-salad/studio/issues/394"
    as_of: "2026-10-04T00:00:00Z"
  - title: "studio's lobby: parseDeclaration, parseListing (lobby/capabilities.mjs) and parseSpend (lobby/run-spend.mjs)"
    url: "https://github.com/arugula-salad/studio/blob/integration/next/lobby/capabilities.mjs"
    as_of: "2026-10-04T00:00:00Z"
  - title: "ws-097, a broker protocol for box capabilities"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-097-a-broker-protocol-for-box-capabilities.md"
    as_of: "2026-10-04T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-04"
reviews: []
constrains:
  - "INTENTIUS/chant#3508"
  - "arugula-salad/studio#394"
  - "ws-097"
  - "path:packages/core/src/workspace/broker-protocol.ts"
  - "path:packages/core/src/workspace/broker-protocol.schema.json"
---

# A broker report names a box's listing and spend
