---
schema: 1
id: "ws-022"
title: "Ids"
state: "decided"
area: "D8"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Ids"
  revision: null
question: "How are node ids written in the composed workspace graph?"
options:
  - id: "a"
    label: "`<member>/<id>`"
    how: "Composed ids take behold's existing `<member>/<id>` form. Inside a member, `::` keeps its multi-stack meaning (`app/web::Bucket`). `chant graph` output never changes."
    tradeoff: "Existing behold layouts keep matching, since member names cannot contain `/`. A single id can carry two separators."
  - id: "b"
    label: "`::`"
    how: "Members are prefixed as `<member>::<id>`, reusing the multi-stack separator."
    tradeoff: "Only one separator exists. The cost is that `::` would name both a member and a stack."
  - id: "c"
    label: "migrate layouts"
    how: "A new scheme is chosen, and saved layouts are migrated to it."
    tradeoff: "The scheme starts clean. Every saved behold layout needs a migration."
choice:
  option: "a"
  reason: "behold already writes `<member>/<id>`. Its saved ids and hand layouts keep matching. Stacks inside a member keep `::` for themselves. Single-project `chant graph` output is untouched."
rejected:
  - option: "b"
    why: "A member prefix written with `::` could not be told apart from a stack prefix. D12 also rules out new meanings for stack."
  - option: "c"
    why: "It would cost every behold user a migration when behold's form already works."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D8. IR"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d8-ir"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, D12. Commands and words"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d12-commands-and-words"
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

# Ids
