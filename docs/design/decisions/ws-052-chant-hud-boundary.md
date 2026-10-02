---
schema: 1
id: "ws-052"
title: "The chant and hud boundary"
state: "decided"
area: "D15"
source:
  issue: "INTENTIUS/chant#2657"
  row: "The boundary"
  revision: null
question: "Which concepts does chant provide with the repository specification, which belong in hud, and which in a plugin, and what keeps that split true?"
options:
  - id: "a"
    label: "chant provides the specification, hud renders and interacts, a plugin owns domain kinds and joins"
    how: "chant provides the repository specification and nothing that faces a person; hud renders and interacts; domain record kinds and joins are a plugin. chant owns the declaration, kinds, members, links, lineage, migrations, `init --from` and `upgrade`; records (schemas, states, seals, pins, supersession, attestation, provenance); the read contract (versioned JSON of `ls`, `graph`, `check`, `records`, `status` and `graph --intent`, with closed reason codes); the writing and verifying commands (`approve`, `records pin`, `verify`, `check`, gates, ledgers); and findings as data. hud owns rendering; review actions as UI (agree, dissent, propose, quorum meter, live sessions); identity, sessions and who is looking; the agent chat, the dev proxy and comment mode; and the question put to the person at each finding. A plugin owns domain record kinds (contracts, units, evidence, drivers, sessions), `commitJoins` and other joins from commits to records, and agent prompts and context bundles. Every concept has one row in `docs/data/boundary.yaml` naming its owner and the schema or command that carries it, and tests keep the roster, the code and the rules in step."
    tradeoff: "Each side can be replaced or run without the other, and a reader other than hud gets everything hud gets. hud has to wait for chant to emit a field before it can show it, and each new concept costs a roster row."
  - id: "b"
    label: "hud reads record files directly"
    how: "hud parses the declaration, the record files and git history itself, and computes pins, supersession, provenance and drift in its own code."
    tradeoff: "hud can show a new field without a chant release. It duplicates chant's parsing, seal and provenance rules in a second codebase, and the two can disagree about whether a record is valid."
  - id: "c"
    label: "chant serves a UI"
    how: "chant grows a `serve` command that listens on a port, authenticates the person and renders the review views, with hud reduced to a theme or dropped."
    tradeoff: "One install gives a working UI. chant becomes a server to secure and operate, takes on identity and sessions, and every chant user carries UI and agent dependencies that level 0 never needed."
  - id: "d"
    label: "one repo for both"
    how: "hud's code moves into this repository, or chant's into hud's, and both ship from one tree with one release."
    tradeoff: "A change that spans both lands in one pull request. Nothing stops the UI reaching past the read contract into core, and a UI release waits on chant's release gates."
choice:
  option: "a"
  reason: "Rules: chant never listens on a port, never authenticates a person, never renders. hud never parses a record file, never runs git for provenance, never computes drift; it reads only through the read contract and writes only through chant commands. chud is the transitional owner of the plugin column (jhgaylor/chud#78, #79, #80). This follows #2524 D8 (consumers read the composed IR and ignore unknown fields), D15 (hud reads exactly as behold does, through a versioned contract with output schemas and closed reason codes) and D18 (the design client is a member with its own lineage). The split is made mechanical: `test/boundary-roster.test.ts` fails when a workspace command, reason code, finding code, link kind or WSP id has no roster row or a row names one that does not exist; `test/no-listener.test.ts` fails when `packages/core` opens a listener or imports a UI or agent-runtime package; and `describeWorkspaceReaderConformance` lets a reader show it consumes only the read contract. Recorded by the maintainer as provisional, like every other `decided` row, until a review ratifies it."
rejected:
  - option: "b"
    why: "Two parsers of the same records drift apart, and a record chant calls invalid could look valid in hud. D15 already says hud reads exactly as behold does."
  - option: "c"
    why: "A port, a login and a renderer are a service to secure and run, and they would load UI and agent packages into every level-0 install. None of them is part of the repository specification."
  - option: "d"
    why: "A shared tree removes the seam the read contract depends on: nothing would stop hud importing core directly, and each side's releases would wait on the other's."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2657, the chant and hud boundary"
    url: "https://github.com/INTENTIUS/chant/issues/2657"
    as_of: "2026-09-24T19:47:58Z"
  - title: "INTENTIUS/chant#2524, D8. IR"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d8-ir"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, D15. Artifact and read contract"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d15-artifact-and-read-contract"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, D18. Design apps"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d18-design-apps"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2650, C. What chant needs, and what belongs in hud"
    url: "https://github.com/INTENTIUS/chant/issues/2650#c-what-chant-needs-and-what-belongs-in-hud"
    as_of: "2026-09-24T16:55:12Z"
  - title: "INTENTIUS/chant#2555, decision records and their review in hud"
    url: "https://github.com/INTENTIUS/chant/issues/2555"
    as_of: "2026-09-24T00:34:56Z"
decided_by: "lex00"
decided_on: "2026-09-24"
reviews: []
constrains:
  - "INTENTIUS/chant#2555"
  - "ws-017"
  - "member:core"
  - "member:test-utils"
  - "path:docs/data/boundary.yaml"
---

# The chant and hud boundary

The owner of each concept is listed in [the roster](../../data/boundary.yaml), rendered on [the boundary reference page](https://intentius.io/chant/reference/boundary/).
