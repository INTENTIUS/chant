---
schema: 1
id: "ws-040"
title: "Environments"
state: "decided"
area: "D19"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Environments (v8)"
  revision: "v8"
question: "How does a workspace line up the environments of its members?"
options:
  - id: "a"
    label: "exact names, warning"
    how: "Environment names match exactly across members. A `WSP` check warns when linked members don't share one."
    tradeoff: "Nothing new to declare. Members that use different names for the same environment get a warning and no mapping."
  - id: "b"
    label: "env map"
    how: "The declaration maps each member's environment names onto shared workspace environments."
    tradeoff: "Handles members that name environments differently. It adds a declaration section and one more place for names to drift."
  - id: "c"
    label: "none"
    how: "The workspace says nothing about environments, and each member keeps its own names."
    tradeoff: "No work. Nothing catches linked members whose environments don't line up."
choice:
  option: "a"
  reason: "Members already name their environments in their own ledgers and pipelines, so exact matching needs no new field. The check only warns, so a member with its own names still builds. Views across members, such as `chant workspace status <env>`, need a shared name to line releases up. The row is new in v8."
rejected:
  - option: "b"
    why: "It adds a mapping to maintain before any workspace has shown it needs one."
  - option: "c"
    why: "Linked members could deploy to environments that don't correspond, and nothing would say so."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D19. Delivery: CI, releases, environments"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d19-delivery-ci-releases-environments"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Environments (v8)"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2542, per-member CI pipelines with path filters, and root CI ownership"
    url: "https://github.com/INTENTIUS/chant/issues/2542"
    as_of: null
  - title: "INTENTIUS/chant#2544, status and compare across members"
    url: "https://github.com/INTENTIUS/chant/issues/2544"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2542"
  - "INTENTIUS/chant#2544"
---

# Environments
