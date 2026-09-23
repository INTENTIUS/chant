---
schema: 1
id: "ws-044"
title: "Forge governance"
state: "decided"
area: "D19"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Forge governance (v8)"
  revision: "v8"
question: "What sets forge settings, such as branch protection and required checks, for a workspace?"
options:
  - id: "a"
    label: "wardens read the contract"
    how: "Core never touches forge settings. The warden repos take the member list from the read contract. Job names and lifecycle paths come from it too, and the wardens gain CODEOWNERS support."
    tradeoff: "Core needs no forge API or credentials. Protection depends on a separate tool being set up."
  - id: "b"
    label: "lexicon generates it"
    how: "The workspace lexicon writes forge settings along with the CI files it generates."
    tradeoff: "One source for CI and its protections. chant would need forge credentials to change settings that aren't files in the repo."
  - id: "c"
    label: "out of scope"
    how: "The workspace says nothing about forge settings."
    tradeoff: "No work. Nothing helps protect the `chant/lifecycle` branch or the per-member checks the design relies on."
choice:
  option: "a"
  reason: "Enforcement happens at a boundary such as CI on a protected branch (threat model), so forge protection matters, but core has no forge settings to manage. The wardens read the same contract as every other reader (D15), so their rules follow the declaration. A warden can require checks per member pipeline and protect the lifecycle branch with a ruleset (github-warden#62). The row is new in v8."
rejected:
  - option: "b"
    why: "It would put forge API calls and credentials into chant core."
  - option: "c"
    why: "The enforcement boundary depends on a protected branch, and leaving it undeclared leaves that to chance."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D19. Delivery: CI, releases, environments"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d19-delivery-ci-releases-environments"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Forge governance (v8)"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Threat model"
    url: "https://github.com/INTENTIUS/chant/issues/2524#threat-model"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/github-warden#62, read workspace members from chant's read contract, and add CODEOWNERS"
    url: "https://github.com/INTENTIUS/github-warden/issues/62"
    as_of: null
  - title: "INTENTIUS/chant#2536, the read contract, with output schemas, reason codes and --at"
    url: "https://github.com/INTENTIUS/chant/issues/2536"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/github-warden#62"
  - "INTENTIUS/chant#2536"
---

# Forge governance
