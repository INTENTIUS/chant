---
schema: 1
id: "ws-054"
title: "A box record kind for coupled decisions"
state: "proposed"
area: "D4"
source:
  issue: "INTENTIUS/chant#2698"
  row: "A box record kind"
  revision: null
question: "How does chant record decisions that constrain each other, so that they are judged as one configuration, settled together into decision records, and reported when a later change to one of them leaves the others assuming the option it replaced?"
options:
  - id: "a"
    label: "a `box` record kind that settles into decision records"
    how: "A box is its own record kind, JSON by ws-053, beside the decision kind. Its file follows eagle-eye's `box.schema.json`: the brief (`problem`, `who`, `when`), rows with options, conflicts and requires edges between options in different rows, each with a why, an optional tier and a src that may pin a file, and optional presets and strawmen. A row is open (options inline, the default) or fixed (a reference to an existing decision); a fact row is reserved in the schema for a second version. A box is proposed, reviewed through `records review` with verdicts bound to its digest, and then `records settle` turns each open row into a decided decision record in one atomic write and closes and seals the box. settle refuses an active conflict or an unmet requirement at every quorum, and refuses when the declared quorum is not met. `records --json` carries each box's closure, and `chant workspace box eval` reads a selection. A decision a settled box produced that is later superseded on its own reports `box-row-superseded` on the box and an intent finding on the regions its siblings constrain."
    tradeoff: "The coupling becomes a record that is reviewed, sealed and pinned by the decisions it produced, and one mechanism serves one person at quorum 0 and a team at any higher quorum. It is a new kind, a new write verb, a new read command and new closed codes, and the write commands must first learn to write JSON records, which they refuse today."
  - id: "b"
    label: "edges stored on decision options"
    how: "Each option of a decision record gains `conflicts` and `requires` lists naming options of other decisions. No new kind: the edges are read from the decision records, and a reader computes conflicts over the chosen options of the decisions it is shown."
    tradeoff: "No new file type. It fails where it matters. A decided record refuses a content change (`amend-supersede-instead`), so an edge can never be added once either end is decided, and superseding a decision to add an edge rewrites a choice nobody changed. One decision can sit in several coupled sets, and each set would add edges to the same options. Nothing holds the configuration as one thing, so there is nothing to review as a whole and nothing for a settle to refuse."
  - id: "c"
    label: "no chant support: eagle-eye boxes kept as scratch files pinned as evidence"
    how: "An author draws the box with eagle-eye, decides each row as a separate decision record, and pins the box file in each record's `evidence`. chant reads nothing in the box."
    tradeoff: "No code in chant, and the box is kept beside the decisions it explains. A pin proves only that the file existed: chant never reads the edges, so nothing refuses a conflicting set, nothing reports coupled drift, and an edited box shows only as `asset-drift` with no sense of which edge changed."
  - id: "d"
    label: "a hud-only view that computes coupling client-side"
    how: "hud reads box files, computes closure, conflicts and the findings in its own code, and shows them beside the decisions. chant keeps the decisions and knows nothing of boxes."
    tradeoff: "hud can show boxes without a chant release. It breaks the ws-052 boundary: hud never parses a record file and never computes drift, and a reader other than hud gets nothing hud gets. Two readers of the same edges can disagree, and settlement, the quorum and coupled drift have no home in chant."
choice: null
rejected: []
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2698, a box record kind, a morphological box over coupled decisions, settled into decision records"
    url: "https://github.com/INTENTIUS/chant/issues/2698"
    as_of: "2026-09-25T16:57:21Z"
  - title: "INTENTIUS/chant#2650, decision-review widgets and the prompts for catching intent drift"
    url: "https://github.com/INTENTIUS/chant/issues/2650"
    as_of: "2026-09-25T16:57:28Z"
  - title: "eagle-eye, in mephistopheles4/grimoire: SKILL.md, box.schema.json, reference/writing-edges.md and render.mjs, read at 1a5dad20"
    url: "https://github.com/mephistopheles4/grimoire/tree/1a5dad208d3f524a13831c3c73b01e598614a46f/skills/eagle-eye"
    as_of: "2026-09-25T02:50:43Z"
  - title: "INTENTIUS/chant#2676, records computes quorum per record and binds a verdict to the digest it judged (review-decider)"
    url: "https://github.com/INTENTIUS/chant/pull/2676"
    as_of: "2026-09-24T22:03:22Z"
  - title: "INTENTIUS/chant#2684, ws-053 decided: JSON records, optional lifecycle, schema refs and content-addressed ids"
    url: "https://github.com/INTENTIUS/chant/pull/2684"
    as_of: "2026-09-24T23:44:49Z"
  - title: "alecraso/hud#613, the integration of the chant stack, the worked example"
    url: "https://github.com/alecraso/hud/pull/613"
    as_of: "2026-09-25T11:35:56Z"
  - title: "ws-053, record formats beyond Markdown front matter"
    path: "docs/design/decisions/ws-053-record-formats.md"
    sha256: "705a0b5ce18960f5b10b5f1a94cd3cfc34eab833dee036aeaf47fecaa456b08b"
  - title: "The design note: the box file, the lifecycle, records settle, the closure, the codes, coupled drift and the implementation issues"
    path: "docs/design/workspace/box-kind.md"
    sha256: "0c9e209b1356c5c8525c10340c7a88623b9abffc5ae11e1ba01ec8b7b9c7a3f5"
  - title: "The worked example: the hud#613 decisions drawn as a box"
    path: "docs/design/workspace/examples/hud-613-integration.box.json"
    sha256: "89a7335b89b5bb1409ceaa055e1c4878e6499928e70af840cfee838010b2a169"
decided_by: null
decided_on: null
reviews: []
constrains:
  - "INTENTIUS/chant#2698"
  - "member:core"
  - "member:reference-workspace"
  - "path:packages/core/src/workspace"
  - "path:docs/design/decisions/decision.schema.json"
x-recommendation:
  option: "a"
  reason: "It is the only option that meets the four constraints decided on 2026-09-25. The edges live in a record that is reviewed and sealed, so settlement can refuse a conflicting set at any quorum, and a later supersession can be traced to the siblings it affects. It reuses the JSON format, the digest, the quorum, the seals and the write commands, and hud stays a renderer of what chant computes."
---

# A box record kind for coupled decisions

Proposed, not decided. The box file, the lifecycle, `records settle`, the closure and `box eval`, the finding codes, coupled drift, the hud#613 worked example and the implementation issues in landing order are in [box-kind.md](../workspace/box-kind.md). The example box is [hud-613-integration.box.json](../workspace/examples/hud-613-integration.box.json).

lex00 decided four constraints with the issue on 2026-09-25, and every option has to meet them:

1. Box-first and decision-first are both supported, and box-first is the default.
2. Settlement refuses an active conflict or an unmet requirement between the chosen options at every quorum, 0 included.
3. Fact rows are deferred to a second version, and the schema reserves them.
4. Solo is quorum 0. One person and a team use the same files and commands, and only `quorum` differs.

Option (b) fails the first two, (c) fails the second and fourth, and (d) fails the ws-052 boundary.
