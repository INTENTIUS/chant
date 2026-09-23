---
schema: 1
id: "ws-023"
title: "Root shrink"
state: "decided"
area: "D0"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Root shrink (v8)"
  revision: "v8"
question: "What do `chant build` and `chant lint` do in a declared workspace once member directories leave the top-level project?"
options:
  - id: "a"
    label: "fail unless `--root-only`"
    how: "Top-level `chant build` and `chant lint` fail in a declared workspace with a `WSP` code that points to the workspace commands. Setting `--root-only` or `rootOnly: true` lets them run anyway."
    tradeoff: "Nobody gets a smaller build without knowing it. Scripts and CI that run `chant build` there must add the flag or switch to `chant workspace build`."
  - id: "b"
    label: "accept and show"
    how: "The two commands keep running on a smaller project. `chant workspace init` and each top-level run print which files were excluded."
    tradeoff: "Existing commands keep working. A printed note is the only sign that they now cover less."
    chosen_in: "v6"
  - id: "c"
    label: "no exclusion"
    how: "Discovery keeps scanning member directories, so the top-level project still includes them."
    tradeoff: "The top-level build never shrinks. It imports every member's source and Ops, so members are built twice."
  - id: "d"
    label: "non-chant only"
    how: "Only members that are not chant projects leave the top-level project."
    tradeoff: "Less code moves out. Chant members are still built twice, and the boundary depends on kind."
choice:
  option: "a"
  reason: "The choice was revised in v8 from accept and show (v6). That option let the top-level commands succeed on a smaller project with only a printed note. In v8 those commands fail with a `WSP` code and point to the workspace commands, and the opt-out keeps the smaller build for anyone who asks. The chant repo is unaffected because its root is an npm workspace (#2557). The source is ambiguous because #2524 does not say why v8 dropped accept and show, so this reason is read from the D0 rule that project commands keep project meaning."
rejected:
  - option: "b"
    why: "v8 replaced it because a build could keep passing on less code with only a note to show it."
  - option: "c"
    why: "Op discovery would load every member's Ops, and duplicate Op names fail."
  - option: "d"
    why: "Chant members would stay in both builds, and the boundary would depend on member kind."
supersedes:
  - revision: "v6"
    option: "b"
evidence:
  - title: "INTENTIUS/chant#2524, D0. Levels of use, all opt-in"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d0-levels-of-use-all-opt-in"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, D12. Commands and words"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d12-commands-and-words"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2537, per-member commands and root-only refusal"
    url: "https://github.com/INTENTIUS/chant/issues/2537"
    as_of: null
  - title: "INTENTIUS/chant#2557, dogfood on the chant repo"
    url: "https://github.com/INTENTIUS/chant/issues/2557"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2537"
  - "INTENTIUS/chant#2534"
  - "INTENTIUS/chant#2526"
---

# Root shrink

See [the levels of use](../workspace-levels.md).
