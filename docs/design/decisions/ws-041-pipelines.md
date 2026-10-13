---
schema: 1
id: "ws-041"
title: "Pipelines"
state: "decided"
area: "D19"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Pipelines (v8)"
  revision: "v8"
question: "How are CI pipelines split across a workspace's members?"
options:
  - id: "a"
    label: "per member per env, plus a workspace one"
    how: "One pipeline per member per environment, path-filtered to the member, with jobs run in its directory. One workspace pipeline follows once workspace Ops exist."
    tradeoff: "A change runs only the jobs of the members it touches. The number of generated files grows with members times environments."
  - id: "b"
    label: "one workspace pipeline"
    how: "A single pipeline builds and deploys every member."
    tradeoff: "One file to read. Every change runs every member, and required checks can't be set per member."
  - id: "c"
    label: "per member only"
    how: "Each member gets its own pipelines, and there is no workspace pipeline."
    tradeoff: "Fewer files. Ops that span members have no pipeline to run in."
choice:
  option: "a"
  reason: "Path filters keep a change in one member from running the others. Each pipeline is a D14 generated file with a named generator, `chant build --components --generate` or `chant run --generate`, so drift is checked like any other generated file. The workspace pipeline waits for workspace Ops, which wait for #1939. The row is new in v8."
rejected:
  - option: "b"
    why: "Every change would run and deploy every member, and the warden couldn't require checks per member pipeline."
  - option: "c"
    why: "Workspace Ops, once they exist, need a pipeline of their own."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D19. Delivery: CI, releases, environments"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d19-delivery-ci-releases-environments"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Pipelines (v8)"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2542, per-member CI pipelines with path filters, and root CI ownership"
    url: "https://github.com/INTENTIUS/chant/issues/2542"
    as_of: null
  - title: "INTENTIUS/chant#2533, chant run --generate: a CLI for scheduled Op pipelines"
    url: "https://github.com/INTENTIUS/chant/issues/2533"
    as_of: null
  - title: "INTENTIUS/chant#2554, workspace Ops, the workspace pipeline and release trains"
    url: "https://github.com/INTENTIUS/chant/issues/2554"
    as_of: null
  - title: "INTENTIUS/github-warden#62, read workspace members from chant's read contract, and add CODEOWNERS"
    url: "https://github.com/INTENTIUS/github-warden/issues/62"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2542"
  - "INTENTIUS/chant#2533"
  - "INTENTIUS/chant#2541"
  - "INTENTIUS/chant#2554"
---

# Pipelines
