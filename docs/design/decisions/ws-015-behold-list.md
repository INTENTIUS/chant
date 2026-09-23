---
schema: 1
id: "ws-015"
title: "behold list"
state: "decided"
area: "D11"
source:
  issue: "INTENTIUS/chant#2524"
  row: "behold list"
  revision: null
question: "What happens to the member list in `.behold.json` once chant has a workspace declaration?"
options:
  - id: "a"
    label: "deprecate, `doctor --fix`"
    how: "Members in `.behold.json` are deprecated after the existing behold kinds move into plugins. Running `behold doctor --fix` writes the equivalent `chant.workspace.json` with stable member names."
    tradeoff: "Users end up with one member list after a conversion they run themselves. The cost is a converter and a deprecation release in behold."
  - id: "b"
    label: "keep both"
    how: "The viewer keeps reading `.behold.json` members indefinitely beside `chant.workspace.json`."
    tradeoff: "Nobody has to convert. The same members stay written in two places, where they can disagree."
  - id: "c"
    label: "convert on first run"
    how: "On its first run, behold rewrites `.behold.json` members into a declaration by itself."
    tradeoff: "There is no manual step. The cost is that behold writes into a directory it serves."
choice:
  option: "a"
  reason: "#2524 counts one member list written in up to three places as a cost, so only the declaration should remain. A conversion the user runs keeps member names stable. Existing ids and hand layouts then keep matching. Deprecation waits until the terraform kind and the other behold kind have moved (#2545), so existing estates keep working."
rejected:
  - option: "b"
    why: "Two lists for the same members can drift apart. That repetition is what the design sets out to remove."
  - option: "c"
    why: "It would write into a served directory unasked. behold adopted a rule against that after real bugs."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D11. behold"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d11-behold"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, D3. Kinds"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d3-kinds"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2545, move the terraform member kind into its lexicon"
    url: "https://github.com/INTENTIUS/chant/issues/2545"
    as_of: null
  - title: "INTENTIUS/behold#464"
    url: "https://github.com/INTENTIUS/behold/issues/464"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/behold#464"
  - "INTENTIUS/chant#2545"
---

# behold list
