---
schema: 1
id: "ws-007"
title: "Nesting"
state: "decided"
area: "D2"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Nesting"
  revision: null
question: "Does an outer workspace ever expand a member that holds its own declaration?"
options:
  - id: "a"
    label: "read-only expansion"
    how: "Such a member has kind `workspace` and stays opaque in phases 1-2. After that the outer view expands it read-only with `outer/inner/id` ids, while every write stays with the inner side."
    tradeoff: "The outer check and viewer can see inside. Since the outer side never writes there, the inner one upgrades itself with its own `chant workspace upgrade`."
  - id: "b"
    label: "never"
    how: "The nested member stays opaque for good."
    tradeoff: "Simplest to build. Outer checks and drift reports never see what it holds."
  - id: "c"
    label: "full"
    how: "An opt-in mode expands it fully so the outer side can also run upgrades there."
    tradeoff: "One place operates everything. Two declarations could then both claim the same ledgers."
  - id: "d"
    label: "flatten"
    how: "The inner members always become members of the outer declaration."
    tradeoff: "One flat member list. The nested boundary and its identity are lost."
choice:
  option: "a"
  reason: "Read-only expansion gives outer checks and the viewer what they need, while every write stays with the side that owns it. An embedded kit that is itself a workspace keeps its own lineage (D13). v8 replaced the expanded id form `outer.inner` in D2 with `outer/inner/id`. The chosen option stayed the same. The source is ambiguous because the Decisions table gives this row no (v8) marker even though v8 changed the id form."
rejected:
  - option: "b"
    why: "Outer checks and the viewer would never see nested members."
  - option: "c"
    why: "Two declarations writing the same gates and ledgers would conflict."
  - option: "d"
    why: "The nested side would lose its boundary and could no longer upgrade or deploy on its own."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D2. Members"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d2-members"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2551, adopt-lineage, the hash index, version reports and nesting"
    url: "https://github.com/INTENTIUS/chant/issues/2551"
    as_of: null
  - title: "INTENTIUS/chant#2534, the declaration, findWorkspaceRoot, chant workspace init and ls"
    url: "https://github.com/INTENTIUS/chant/issues/2534"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2551"
  - "INTENTIUS/chant#2534"
---

# Nesting
