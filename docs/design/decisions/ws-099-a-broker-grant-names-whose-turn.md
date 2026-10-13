---
schema: 1
id: "ws-099"
title: "A broker's grant names whose turn a model call is"
state: "decided"
area: "D15"
source:
  issue: "INTENTIUS/chant#3477"
  row: "a box names whose turn a model call is with a grant its broker issued (chant-grant)"
  revision: null
question: "How does a shared box tell its broker that a model call is a particular person's turn, in a form the broker can check, so the broker can spend that person's own credential on their turns only?"
options:
  - id: "a"
    label: "a grant the broker issued, sent by the box as a chant-grant header on that person's turns"
    how: "The broker issues a grant to a person for one box through whatever surface signs that person in at the broker, and the person's browser carries it to the box's surface. The surface sends it as chant-grant on inference and decide requests made on that person's turns. The broker checks its own grant (issued by it, for the box whose token the request carries, not expired or revoked, the person still holding a credential), spends the person's credential and answers chant-payer: visitor <principal>. A grant it does not accept is ignored. broker-protocol.ts names GRANT_HEADER, GRANT_MAX_LENGTH and isGrantValue; the grant itself is opaque."
    tradeoff: "The grant reaches the agent's process for the person's turn, so code the agent runs then can read it and use it later from the same box until it expires or the broker revokes it. Short grants and the box binding bound that; the turn does not."
  - id: "b"
    label: "a per-turn assertion the box signs with a key the broker trusts"
    how: "The box's surface holds a private key out of the agent's reach and signs { person, turn, expiry } for each turn; the broker checks the box's public key."
    tradeoff: "Binds the assertion to the turn, but needs a channel that registers the box's public key with the broker that the box's agent cannot use, and every request a box makes carries the box's own token, which the agent also holds. No such channel exists in version 1."
  - id: "c"
    label: "join the request to chant's run record and its by"
    how: "The box sends its run id; the broker reads the run ledger to learn who prompted."
    tradeoff: "The broker would have to read the box's repo, and the run's by is written from the box, so it is the box's word again."
choice:
  option: "a"
  reason: "Only the broker can vouch for a person without trusting the box, and it already signs people in. A grant it issued and checks itself needs no key on the box and no new route, keeps the person's credential at the broker, and composes with ws-098's payer, so the box hears that the visitor paid. Its limit, that a grant lives longer than one turn, is stated where the protocol defines it."
rejected:
  - option: "b"
    why: "No channel in version 1 registers a box key the agent cannot also register; it can follow once one does."
  - option: "c"
    why: "It takes the box's word for who prompted and makes the broker read the repo."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3477, a box names whose turn a model call is with a grant its broker issued"
    url: "https://github.com/INTENTIUS/chant/issues/3477"
    as_of: "2026-10-04T00:00:00Z"
  - title: "arugula-salad/hud#864, a checkable whose turn for the lobby's LLM proxy"
    url: "https://github.com/arugula-salad/hud/issues/864"
    as_of: "2026-10-04T00:00:00Z"
  - title: "ws-098, a broker says whose credential pays"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-098-a-broker-says-whose-credential-pays.md"
    as_of: "2026-10-04T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-04"
reviews: []
constrains:
  - "INTENTIUS/chant#3477"
  - "ws-097"
  - "ws-098"
  - "arugula-salad/hud#864"
  - "member:core"
  - "path:packages/core/src/workspace/broker-protocol.ts"
---

# A broker's grant names whose turn a model call is
