---
schema: 1
id: "ws-037"
title: "Markers"
state: "decided"
area: "D7"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Markers (v8)"
  revision: "v8"
question: "How do the resources that different members deploy stay distinguishable by their ownership markers?"
options:
  - id: "a"
    label: "unique `ownership.stack` per member, checked"
    how: "Nothing about the marker format changes. A `WSP` check requires distinct `ownership.stack` values across members, and `workspace init` proposes one per member."
    tradeoff: "No lexicon's marker code or deployed resource changes. Members whose stacks already collide have to be renamed before the check passes."
  - id: "b"
    label: "new member key"
    how: "The existing `stack` value stays and a separate member key is added beside it, because `<member>::<stack>` is not a legal label value. A `legacy` member accepts the old marker."
    tradeoff: "Members are told apart even when stacks repeat. Every lexicon's marker writing and teardown matching changes, and deployed resources need the `legacy` path to stay owned."
    chosen_in: "v5"
  - id: "c"
    label: "stack defaults to member"
    how: "When a member sets no `ownership.stack`, its stack value defaults to the member name."
    tradeoff: "Stacks are distinct with no configuration. Resources already deployed under today's default stack would carry a value that no longer matches, and the word stack would gain a member meaning."
choice:
  option: "a"
  reason: "The choice was revised in v8 away from a new member key, which the table says v5 chose; the earlier choice is in the #2524 edit history. D7 needs no marker change, since distinct `ownership.stack` values already separate members. The source is ambiguous because the v3 and v4 texts already chose the member key, so the v5 label on that option looks late."
rejected:
  - option: "b"
    why: "A new key would change marker writing and teardown in every lexicon when distinct stack values give the same separation."
  - option: "c"
    why: "Defaulting the stack to the member name would change markers for resources already deployed and give stack a member meaning, which D12 rules out."
supersedes:
  - revision: "v5"
    option: "b"
evidence:
  - title: "INTENTIUS/chant#2524, D7. Ledgers"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d7-ledgers"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, D12. Commands and words"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d12-commands-and-words"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Markers (v8)"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2538, member ledgers under _members/ and unique ownership stacks"
    url: "https://github.com/INTENTIUS/chant/issues/2538"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2538"
  - "INTENTIUS/chant#2534"
---

# Markers
