---
schema: 1
id: "ws-033"
title: "Audit extensions"
state: "decided"
area: "D16"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Audit extensions"
  revision: null
question: "Where do `chant audit` checks come from once workspace plugins exist?"
options:
  - id: "a"
    label: "lexicons only"
    how: "Audit checks keep coming only from lexicons. Workspace plugins cannot add them."
    tradeoff: "`chant audit` and its extension point stay as they are. A member kind with no lexicon gets no audit coverage."
  - id: "b"
    label: "plugin `auditChecks()`"
    how: "Workspace plugins gain an `auditChecks()` hook that adds audit checks for their kinds."
    tradeoff: "Kinds without a lexicon could be audited. It adds a second source of audit checks before any kind needs one."
choice:
  option: "a"
  reason: "D16 keeps audit checks in lexicons only. The v6 text says workspace plugins cannot add them until a real member kind needs coverage that a lexicon can't give."
rejected:
  - option: "b"
    why: "No member kind needs audit coverage that a lexicon can't give yet, so a second extension point would have no user."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D16. Audit, lint and checks"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d16-audit-lint-and-checks"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Audit extensions"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2535, member kinds from a data-only subpath, and WorkspaceCheck"
    url: "https://github.com/INTENTIUS/chant/issues/2535"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2535"
  - "INTENTIUS/chant#2537"
---

# Audit extensions
