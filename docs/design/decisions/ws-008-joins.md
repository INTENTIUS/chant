---
schema: 1
id: "ws-008"
title: "Joins"
state: "decided"
area: "D6"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Joins"
  revision: null
question: "What key joins a consumer to a producer's output across members, and who defines it?"
options:
  - id: "a"
    label: "exact declared, core `joinKey()`"
    how: "Declared member links are stated on the consumer as `{member, output}` and compared exactly. Inferred joins use one core `joinKey()`, and each is labelled `exact` or `folded` (case and punctuation folded)."
    tradeoff: "Declared links behave the way deploy does, and every reader labels inferred edges the same way. The viewer and its composer have to drop their own matchers."
  - id: "b"
    label: "tool matchers"
    how: "Each tool, such as behold's composer, keeps its own name matcher."
    tradeoff: "No tool has to change. The same workspace can show different edges in different readers."
  - id: "c"
    label: "exact or folded everywhere"
    how: "A single rule covers every join. It is exact comparison in one variant and folded comparison in the other."
    tradeoff: "One rule to explain. Exact comparison misses every real inferred join today, and folding lets declared links accept names deploy would reject."
choice:
  option: "a"
  reason: "Every real inferred join today needs folding (`ClusterArn` against `clusterArn`), while deploy matches exactly. Declared links therefore stay exact, and inferred joins are labelled by how they were joined. One core function keeps every reader in agreement. The source is ambiguous because the v6 table rejected \"exact everywhere\" and \"folded everywhere\" as two options, and the current table merges them into one."
rejected:
  - option: "b"
    why: "Readers would disagree about which edges exist in the same workspace."
  - option: "c"
    why: "Exact everywhere misses today's joins, and folded everywhere loosens declared links past what deploy accepts."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D6. Links"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d6-links"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2539, member links stated on the consumer and checked in source"
    url: "https://github.com/INTENTIUS/chant/issues/2539"
    as_of: null
  - title: "INTENTIUS/behold#464"
    url: "https://github.com/INTENTIUS/behold/issues/464"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2539"
  - "INTENTIUS/behold#464"
---

# Joins
