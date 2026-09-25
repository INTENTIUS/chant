---
schema: 1
id: "ws-058"
title: "Decision points: typed questions over the workspace graph, with table, model and quorum deciders"
state: "decided"
area: "D20"
source:
  issue: "INTENTIUS/chant#2723"
  row: "Decision points"
  revision: null
question: "Where do a workspace's recurring questions live (which builder tier builds a work item, may a release skip the human gate, what to do about a finding, does a change need a decision), with their deciders and the answers they leave, so that a model such as Jev can prompt decisions on the work graph without chant running a model or any answer settling on its own?"
options:
  - id: "a"
    label: "points declared in the workspace, answers as records, the model call as an Op activity"
    how: "Points: a declared file, `decisions/points.json` or a record kind, validated by a schema chant ships, taken from chud's `decision-points.schema.json`. Each point has a typed question (`noul`, `choice` with candidates, or `score` with 2 to 10 ordered levels), the inputs it reads (named read-contract outputs: a work item, a finding from `graph --intent`, a decision, a release plan), and an ordered chain of deciders: `table` rows that answer when their conditions hold, `model` deciders with a backend, a pinned model id and a threshold, and a `quorum` of people, always last. Answers: each answer is a record, `proposed` unless a table or a quorum gave it, with the point, the inputs' hash, the decider, and, for a model, the probabilities, confidence and threshold, plus a `source` block (#2708). A model answer at or above its threshold is a proposal a person confirms; below it, the question escalates. The same point, declaration and inputs are answered once. The model call: chant never calls a model on a read path (ws-052). A `decide` Op activity in a verbs-only typed-decision lexicon (#2491) calls a backend (Jev's `POST /v1/systemone` wire format, or any compatible one), and hud's Decider interface or the studio kit may make the same call. The backend's key is brokered (#2726). Reading: the read contract lists open questions (escalated or unanswered), with any model answer and its confidence, so hud can prompt a person and MCP clients can see them."
    tradeoff: "The questions become specification, visible and reviewable like any record, and every model answer is traceable to its inputs and threshold. It adds a declaration schema, an answer record shape, one read-contract output and an Op activity. Thresholds set on hand-picked data (chaff's, hud's spike) become visible, which is the point."
  - id: "b"
    label: "points in a typed-decision lexicon, answers in a ledger"
    how: "Points are lexicon resources, and answers are lines in a `_decisions/<point>.jsonl` ledger on chant/lifecycle, not records."
    tradeoff: "The history is append-only and cheap. But an answer is a decision a person may confirm, review or contest, and a ledger line has no review, no quorum and no place in the intent graph. The records machinery exists for exactly that."
  - id: "c"
    label: "points stay in the thin layer's code"
    how: "Each runtime (the studio kit, chaff, hud) keeps its own points and thresholds in code and writes answers as ordinary decision records."
    tradeoff: "No chant change. The same questions and thresholds are written three times, only the runtime that owns a point can see it, and nothing tells a reader which model answered with what confidence. That is today's state: chud's decide.mjs, chaff's kernel/decide.mjs, and hud's Decider."
choice:
  option: "a"
  reason: "An answer is a decision, so it belongs in the records machinery with review, quorum and the intent graph; the points are the questions a workspace asks of its own graph, so they belong in its specification; the model call stays in an Op activity or a runtime's decider, which keeps ws-052's line."
rejected:
  - option: "b"
    why: "A ledger line has no review, no quorum and no place in the intent graph, and a model's answer is a decision a person may confirm or contest."
  - option: "c"
    why: "It keeps the same questions and thresholds in three runtimes' code, where only the owning runtime can see them."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2723, decision points as workspace specification, prompting decisions on the work graph"
    url: "https://github.com/INTENTIUS/chant/issues/2723"
    as_of: "2026-09-25T22:20:00Z"
  - title: "INTENTIUS/chant#2491, research: a lexicon for typed-decision models (Jev), with the wire format from TypeSafe's docs"
    url: "https://github.com/INTENTIUS/chant/issues/2491"
    as_of: "2026-09-25T22:20:00Z"
  - title: "chud's decision points: the table, model and quorum chain and its records (packages/runtime/src/decide.mjs at jhgaylor/chud 43afcf1)"
    url: "https://github.com/jhgaylor/chud/blob/43afcf108d40a8b7b4c14544b8991451a5a56f2f/packages/runtime/src/decide.mjs"
    as_of: "2026-09-25T22:20:00Z"
  - title: "chud's points file: slice-tier and ship-skip (template/delivery/decisions/points.yaml at 43afcf1)"
    url: "https://github.com/jhgaylor/chud/blob/43afcf108d40a8b7b4c14544b8991451a5a56f2f/template/delivery/decisions/points.yaml"
    as_of: "2026-09-25T22:20:00Z"
  - title: "hud's Jev spike #440: gate on hazard nouls, never auto-allow, thresholds on held-out data (docs/spike-440-jev.md in arugula-salad/hud)"
    url: "https://github.com/arugula-salad/hud/blob/main/docs/spike-440-jev.md"
    as_of: "2026-09-25T22:20:00Z"
  - title: "chaff's understand point: table, Jev, then the person (kernel/decide.mjs in arugula-salad/chaff, proposal #48)"
    url: "https://github.com/arugula-salad/chaff/issues/48"
    as_of: "2026-09-25T22:20:00Z"
decided_by: "lex00"
decided_on: "2026-09-25"
reviews: []
constrains:
  - "INTENTIUS/chant#2723"
  - "member:core"
  - "path:packages/core/src/workspace"
x-recommendation:
  option: "a"
  reason: "An answer is a decision, so it belongs in the records machinery, with review, quorum and the intent graph. The points are the questions a workspace asks of its own graph, so they belong in its specification. Keeping the model call in an Op activity keeps ws-052's line: chant declares and records, and a runtime or an Op calls the model."
---

## Context

chud, chaff and hud each carry their own version of the same idea: a typed question, answered first by rules, then by a model above a threshold, then by people. chud has `decide.mjs` and `points.yaml`, chaff has `kernel/decide.mjs`, and hud has its `Decider` from the Jev spike. The questions that matter most read the workspace graph: which tier builds a work item, whether a finding becomes work, whether a change needs a decision, and whether a release may skip its gate. Jev's job is to judge that graph.

## Recommendation

Option a. Declare the points in the workspace, record every answer as a record with its model values and a `source` block, and make the model call through an Op activity or a runtime's decider, never through a chant read.

## Implementation issues, if option a is chosen

1. The points schema and declaration, carried over from chud's `decision-points.schema.json`, with inputs named as read-contract outputs.
2. The answer record shape and its validation (a model answer is proposed; the same inputs are answered once).
3. The `decide` Op activity in a verbs-only typed-decision lexicon (#2491), with a Jev-compatible backend and a stub for tests.
4. Open questions in the read contract and over MCP (#2707).
5. The first points on the work graph: finding triage, needs-a-decision, and slice-tier (ws-057); ship-skip moves from chud.
