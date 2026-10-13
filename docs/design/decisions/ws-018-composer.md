---
schema: 1
id: "ws-018"
title: "Composer"
state: "decided"
area: "D8"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Composer"
  revision: null
question: "Who composes the members of a declared workspace into one graph?"
options:
  - id: "a"
    label: "chant for declared"
    how: "`chant workspace graph` composes a declared workspace, reading each member through that member's own `chant graph`. behold keeps its composer only for loose directories."
    tradeoff: "Every reader sees the same composition, and behold's per-member cache moves into chant. The composer and that cache become chant's to maintain."
  - id: "b"
    label: "viewer"
    how: "Each viewer composes members itself from their per-member graphs, as behold does today."
    tradeoff: "chant stays smaller. Each reader repeats the work, and two readers may compose differently."
  - id: "c"
    label: "both"
    how: "Both chant and the viewers compose, kept equal by a conformance test."
    tradeoff: "Viewers keep control. The price is two composers plus a test to hold them in agreement."
choice:
  option: "a"
  reason: "Otherwise hud and behold would each carry a composer, while the design wants one read contract. With one composer for declared workspaces, the composed IR is defined in a single place. Loose views are the exception (D11)."
rejected:
  - option: "b"
    why: "Every reader would repeat composition. Two readers could then show the same workspace differently."
  - option: "c"
    why: "Two composers need a conformance test to stay equal, which costs more than keeping one."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D8. IR"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d8-ir"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, D11. behold"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d11-behold"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2537, per-member build, lint, audit and graph"
    url: "https://github.com/INTENTIUS/chant/issues/2537"
    as_of: null
  - title: "INTENTIUS/behold#464"
    url: "https://github.com/INTENTIUS/behold/issues/464"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2537"
  - "INTENTIUS/behold#464"
---

# Composer
