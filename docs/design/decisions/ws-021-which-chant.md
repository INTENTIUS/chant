---
schema: 1
id: "ws-021"
title: "Which chant"
state: "decided"
area: "D15"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Which chant"
  revision: null
question: "Which chant reads the workspace declaration?"
options:
  - id: "a"
    label: "root's, gated fallback"
    how: "The version the root pins reads the declaration. If the root pins none, a reader may use its own bundled copy when that copy meets the declaration's `minReader`. Members are always read by their own toolchain."
    tradeoff: "A root with no pin, such as a Terraform-only root, stays readable. The `minReader` gate keeps an old reader away from a newer format."
  - id: "b"
    label: "reader's"
    how: "Whatever version the reader bundles reads every declaration."
    tradeoff: "Readers stay simple. An older reader could misread a declaration written for a newer release."
  - id: "c"
    label: "root must pin"
    how: "A root must pin a version, or the workspace cannot be read."
    tradeoff: "There is always one known reader. A root with no project of its own needs a pin just to be listed."
choice:
  option: "a"
  reason: "The root's pin names the version the declaration was written for, so that version reads it when there is one. A root without a pin should stay viewable, and the `minReader` gate keeps the fallback safe. Members keep their own toolchains, because behold found that members pin different versions."
rejected:
  - option: "b"
    why: "A reader's copy may predate the declaration. Without the `minReader` gate it could misread it."
  - option: "c"
    why: "It forces a pin onto roots that hold no chant project, such as Terraform-only estates."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D15. Artifact and read contract"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d15-artifact-and-read-contract"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, D3. Kinds"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d3-kinds"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2536, the read contract, with output schemas, reason codes and --at"
    url: "https://github.com/INTENTIUS/chant/issues/2536"
    as_of: null
  - title: "INTENTIUS/chant#2535, member kinds from a data-only subpath"
    url: "https://github.com/INTENTIUS/chant/issues/2535"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2536"
  - "INTENTIUS/chant#2535"
  - "INTENTIUS/chant#2534"
---

# Which chant
