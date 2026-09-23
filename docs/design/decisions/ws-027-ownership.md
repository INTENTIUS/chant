---
schema: 1
id: "ws-027"
title: "Ownership"
state: "decided"
area: "D16"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Ownership"
  revision: null
question: "Which tool owns a given finding, so that exactly one of them fails on it?"
options:
  - id: "a"
    label: "by subject"
    how: "Each tool covers one subject. Doctor answers whether the toolchain runs. `chant lint` reads one project's source. `chant audit` scans files on disk. `workspace check` takes the declaration and anything that crosses members."
    tradeoff: "Each finding has exactly one owner that fails on it, and the existing tools keep their meaning. A user has to know which tool covers which subject."
  - id: "b"
    label: "by severity"
    how: "Findings are split by how serious they are, so errors go to one place and warnings to another, whatever the finding is about."
    tradeoff: "A single entry point could gate on every error. The same subject would then be checked in several places, and `chant lint` or `chant audit` would change what they report at level 0."
choice:
  option: "a"
  reason: "D16 gives every finding one owner by subject. The existing tools keep their subjects at level 0 (D0). Everything that crosses members goes to `workspace check`, which is the only new owner."
rejected:
  - option: "b"
    why: "Splitting by severity would spread one subject across several tools and change what they report at level 0."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D16. Audit, lint and checks"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d16-audit-lint-and-checks"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Ownership"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2535, member kinds from a data-only subpath, and WorkspaceCheck"
    url: "https://github.com/INTENTIUS/chant/issues/2535"
    as_of: null
  - title: "INTENTIUS/chant#2537, per-member build, lint, audit and graph"
    url: "https://github.com/INTENTIUS/chant/issues/2537"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2535"
  - "INTENTIUS/chant#2537"
  - "ws-028"
---

# Ownership
