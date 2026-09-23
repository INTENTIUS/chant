---
schema: 1
id: "ws-016"
title: "Identity"
state: "decided"
area: "D15"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Identity"
  revision: null
question: "What identifies a workspace to the tools that read it?"
options:
  - id: "a"
    label: "name and revision"
    how: "Identity is the declared `name` plus a git revision. `chant workspace ls/graph/check --at <rev>` read from git objects offline, and remote URLs come later."
    tradeoff: "Any revision can be read offline without a checkout. Base-revision policy reads use the same path, while remote reads wait for a later release."
  - id: "b"
    label: "path"
    how: "The directory holding the declaration is the identity."
    tradeoff: "There is nothing new to define. A path names no version, though, so two checkouts look like two workspaces."
  - id: "c"
    label: "archive"
    how: "Readers download a published archive and treat it as the workspace."
    tradeoff: "An archive is fixed and portable. Someone has to publish it before anyone can read it."
  - id: "d"
    label: "lock hash"
    how: "The content address recorded in the lineage lock names the workspace."
    tradeoff: "That id is content-addressed. Only workspaces made from a template have a lock, and its hash names no commit."
choice:
  option: "a"
  reason: "Every workspace in git already has a name and revisions, so this identity costs nothing extra. Reading `--at <rev>` from git objects stays offline, and the threat model's base-revision policy reads use the same path. Exports and hud record the name and revision they show, as does behold's static output."
rejected:
  - option: "b"
    why: "A path carries no version. A reader could not say which state it showed, and it could not read a base revision."
  - option: "c"
    why: "It adds a publish step before anything can be read. A workspace in git already has a fixed identity in its revision."
  - option: "d"
    why: "A workspace not made from a template has no lock. The lock hash also says nothing about which commit is shown."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D15. Artifact and read contract"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d15-artifact-and-read-contract"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Threat model"
    url: "https://github.com/INTENTIUS/chant/issues/2524#threat-model"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2536, the read contract, with output schemas, reason codes and --at"
    url: "https://github.com/INTENTIUS/chant/issues/2536"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2536"
---

# Identity
