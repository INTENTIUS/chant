---
schema: 1
id: "ws-012"
title: "Entering level 1"
state: "decided"
area: "D0"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Entering level 1"
  revision: null
question: "What makes a directory a workspace?"
options:
  - id: "a"
    label: "file, proposed by init"
    how: "Only a `chant.workspace.json` creates a workspace. `chant workspace init` finds existing chant projects and proposes a declaration, and it writes the file only after the user confirms."
    tradeoff: "No workspace code loads without the file, so level 0 is untouched. Entering level 1 takes one explicit step."
  - id: "b"
    label: "inference"
    how: "chant infers a workspace from the directory, for example from several chant projects or npm workspaces, with no file."
    tradeoff: "No setup at all. Users who never asked for a workspace could get workspace behaviour."
  - id: "c"
    label: "hand-written only"
    how: "Users write the declaration by hand, and there is no init command."
    tradeoff: "One less command to build. Every workspace starts from a blank file, and existing projects aren't found for the user."
choice:
  option: "a"
  reason: "Only a file keeps level 0 identical. Without it no workspace code loads and chant guesses nothing. `chant workspace init` removes the cost of writing it by hand, reusing the kind of detection behold already does. The row was added in v5 together with D0."
rejected:
  - option: "b"
    why: "Inference would change behaviour for users who never opted in, which breaks D0."
  - option: "c"
    why: "It makes entering level 1 harder when init can propose the file for the user to confirm."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D0. Levels of use, all opt-in"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d0-levels-of-use-all-opt-in"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2525, the workspace driver and its rules"
    url: "https://github.com/INTENTIUS/chant/issues/2525"
    as_of: null
  - title: "INTENTIUS/chant#2534, the declaration, findWorkspaceRoot, chant workspace init and ls"
    url: "https://github.com/INTENTIUS/chant/issues/2534"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2534"
---

# Entering level 1

See [the levels of use](../workspace-levels.md).
