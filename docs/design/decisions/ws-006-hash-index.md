---
schema: 1
id: "ws-006"
title: "Hash index"
state: "decided"
area: "D9"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Hash index"
  revision: null
question: "Where does the per-version file-hash index that `adopt-lineage` matches against come from?"
options:
  - id: "a"
    label: "computed from tags"
    how: "chant computes the index on demand by rendering each tagged template version with and without parameter masking. A copy published by the template's CI may act as a cache that chant re-checks."
    tradeoff: "Any template that tags its releases can be adopted with no extra publishing. Each tagged version costs a render, and templates must tag releases."
  - id: "b"
    label: "template CI"
    how: "Only the template's own CI publishes the index, and `adopt-lineage` reads that copy."
    tradeoff: "Cheap for chant. A template without that CI job can't be adopted, and the published copy is trusted as is."
  - id: "c"
    label: "a registry"
    how: "A registry that chant runs stores the index for every known template."
    tradeoff: "One place to look. chant would have to host and maintain a service that adoption depends on."
choice:
  option: "a"
  reason: "In v3, scenario 6 passed only if someone published a per-version hash index. Computing it from template tags removes that dependency, so any tagged template can be adopted. A CI copy only saves time, and chant re-checks it."
rejected:
  - option: "b"
    why: "Adoption would depend on each template publishing an index, and the copy would be trusted without a re-check."
  - option: "c"
    why: "It needs a hosted service chant doesn't run, and adoption would stop when that service does."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D9. Templates and upgrade"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d9-templates-and-upgrade"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2551, adopt-lineage, the hash index, version reports and nesting"
    url: "https://github.com/INTENTIUS/chant/issues/2551"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2551"
---

# Hash index
