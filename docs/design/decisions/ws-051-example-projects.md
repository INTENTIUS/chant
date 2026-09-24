---
schema: 1
id: "ws-051"
title: "Example and fixture projects"
state: "decided"
area: "D2"
source:
  issue: "INTENTIUS/chant#2556"
  row: "Example and fixture projects"
  revision: null
question: "How does a workspace declare projects that exist only as examples or test fixtures?"
options:
  - id: "a"
    label: "example group"
    how: "One declared entry with kind `examples` and a glob, such as `{ \"name\": \"lexicon-examples\", \"kind\": \"examples\", \"glob\": \"lexicons/*/examples/*\" }`. Each directory the glob matches that holds a chant project is built and linted. A group has no ledger, no releases and no links, and its matches are never members of their own. A match may sit inside another member's directory, as `lexicons/aws/examples/*` sits inside `lexicons/aws`; that member's build and lint leave the match to the group."
    tradeoff: "One line covers many projects, and they keep build and lint coverage. It needs a new built-in kind with rules of its own."
  - id: "b"
    label: "one member each"
    how: "Every example and fixture is declared as a full member."
    tradeoff: "Accurate, but the chant repo alone would list 170 entries, each with a name, a ledger path and a place in the graph for something that never deploys."
  - id: "c"
    label: "other"
    how: "The example trees are declared as `other` members with a `because`."
    tradeoff: "Nothing new to build. `other` is never read, so the examples lose build and lint coverage at the workspace level."
  - id: "d"
    label: "leave undeclared"
    how: "Nothing declares them, and root discovery skips them."
    tradeoff: "Nothing to write, but `chant workspace build` and `lint` never cover them."
choice:
  option: "a"
  reason: "Examples and fixtures need build and lint coverage and nothing else. A group gives them that in one line per tree, and keeps ledgers, names and links for members that deploy. Recorded by the maintainer as provisional, like every other `decided` row, until a review ratifies it."
rejected:
  - option: "b"
    why: "170 members, each with ledger paths and names, for projects that never deploy makes the declaration unreadable."
  - option: "c"
    why: "`other` is never read, so the examples would lose the build and lint coverage they have today."
  - option: "d"
    why: "The workspace commands would never cover the examples, so their coverage would depend on scripts outside the declaration."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2556, how to declare example and fixture projects"
    url: "https://github.com/INTENTIUS/chant/issues/2556"
    as_of: "2026-09-24T01:27:16Z"
  - title: "INTENTIUS/chant#2524, D2. Members"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d2-members"
    as_of: null
  - title: "INTENTIUS/chant#2524, D3. Kinds"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d3-kinds"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-24"
reviews: []
constrains:
  - "INTENTIUS/chant#2534"
  - "INTENTIUS/chant#2535"
  - "INTENTIUS/chant#2557"
---

# Example and fixture projects
