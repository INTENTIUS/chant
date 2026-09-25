# A box record kind for coupled decisions

The design note behind [ws-054](../decisions/ws-054-box-record-kind.md), for [#2698](https://github.com/INTENTIUS/chant/issues/2698) under [#2650](https://github.com/INTENTIUS/chant/issues/2650). The decision is proposed and not decided. The note recommends option (a) and writes it out far enough to build: the file, the lifecycle, `records settle`, the closure, the finding codes, coupled drift, a worked example and the implementation issues in landing order.

## What chant has today

chant records one decision at a time. The only relations between decision records are `supersedes` and the proposed `rests_on` (#2650 C7), so two decisions that constrain each other look independent once they are written down. A later reader who supersedes one of them gets no sign that a choice made alongside it assumed the option they replaced.

The design reuses these mechanisms, each already in `packages/core/src/workspace`:

| Mechanism | Where | What the box takes from it |
|---|---|---|
| JSON records, optional lifecycle and schema refs | `records.ts`, ws-053, #2684 | A box is one JSON object per file, read and validated like any other record. |
| Kind blocks | `session` in `records.ts` and `record-sessions.ts` (#2673), `work` in `work.ts` (#2683) | A kind file declares a `box` block, as a session kind declares `session` and a work kind declares `work`. |
| The record digest | `recordTextDigest` and `digestFields` in `records.ts` (#2672, #2688) | A verdict on a box is bound to the box's digest, so an edited edge drops earlier verdicts. |
| The quorum | `computeQuorum` in `records.ts` (#2671, #2676) | The same count, with `review-decider` leaving out the box's author, and the declaration's `quorum` as the only dial. |
| Sealed verdicts and author seals | `trust/seal.ts`, #2691, #2688 | Unchanged on a box's `reviews` and its top-level `seal`. |
| The closing seal | `sessionSeal` in `record-sessions.ts`, `records close` (#2693) | A settled box carries a digest of its own text, checked on every read, as a closed session does. |
| The write commands | `records new`, `amend`, `review` in `records-write.ts` (#2670) | A box is created, edited and reviewed through them. Today they refuse a JSON kind (`write-usage-invalid`), so issue 1 below lifts that. |
| Work items from findings | `source.finding` and `source.region` in the work kind (#2683) | A work item names the coupled-drift intent finding and the region it fires on. |

## Constraints decided on 2026-09-25

lex00 made four decisions for #2698 before any option was written. Every option is judged against them.

1. Both authoring paths are supported. Box-first is the default: the rows and options are written inline while the question is live. Decision-first is supported: a row may reference an existing decision.
2. Settlement refuses an active conflict or an unmet requirement between the chosen options, at every quorum, 0 included.
3. Fact rows, whose options are read from the workspace, are deferred to a second version. The first version's schema reserves them.
4. A solo workspace is quorum 0. One person and a team use the same files and the same commands, and only `quorum` differs.

## The options

| Option | Holds the edges in | Meets the constraints | Why it wins or loses |
|---|---|---|---|
| (a) a `box` record kind | a box file beside the decisions | all four | Edges live in a record that can be proposed, reviewed and sealed, and settle turns the configuration into decisions in one write. |
| (b) edges on decision options | `conflicts` and `requires` on each option of each decision record | fails 1 and 2 | A decided record refuses a content change (`amend-supersede-instead` in `records-write.ts`), so an edge can never be added once either end is decided, and one decision in several boxes needs edges from several contexts on one option. Nothing reads a configuration as one thing, so there is nothing to refuse at settlement. |
| (c) no chant support | eagle-eye box files in scratch, pinned as evidence | fails 2 and 4 | A pin says the file existed. chant never reads its edges, so nothing refuses a conflict and nothing reports coupled drift. An edit to the box shows only as `asset-drift`, with no sign of which edge changed. |
| (d) a hud-only view | hud's own reading of the edges | fails the ws-052 rules | hud would parse box files and compute closure, conflicts and drift in its own code. ws-052 says hud never parses a record file and never computes drift, and a second reader of the same edges can disagree with the first. |

## The box file

A box is a JSON record (ws-053). Its shape follows eagle-eye's [`box.schema.json`](https://github.com/mephistopheles4/grimoire/blob/1a5dad208d3f524a13831c3c73b01e598614a46f/skills/eagle-eye/box.schema.json) at grimoire 1a5dad20 field for field, and adds chant's own fields around it. eagle-eye's renderer validates by hand and ignores fields it does not know, so it reads a chant box, and chant reads an eagle-eye file once the chant header fields are added. The worked example below is both: `render.mjs --check` passes it, and every chant field in it is the shape this table proposes.

| Field | eagle-eye | chant box | Difference |
|---|---|---|---|
| `schema` | absent | `1`, required | chant's format version. |
| `id` | absent | required, `<prefix>-NNN` as a decision id is | `records new box` allocates it. |
| `state` | absent | `proposed`, `settled` or `withdrawn`; `settled` and `withdrawn` are closed | A box has no `supersedes`: a later box references the earlier box's decisions as fixed rows. |
| `author` | absent | required, a forge login | The quorum's decider (`reviews.decider`), so the author's own verdict never counts (`review-decider`). |
| `area` | absent | optional | Copied into each decision settle writes. A decided record needs one, so settle refuses without it. |
| `title`, `eyebrow` | required, optional | the same | None. |
| `problem`, `who`, `when` | the brief: `problem` required, the others optional | the same | None. |
| `dims` | the rows | the same name, so eagle-eye reads them | Each row gains `kind`: `open` (the default, so an eagle-eye row is an open row), `fixed` or `fact`. |
| `dims[].opts` | inline options, one `chosen` per row | the same on an open row | An option may add `how` and `tradeoff`, which settle copies into the decision. At most 26 options, since a decision's option ids are the letters `a` to `z`. |
| `dims[]` of kind `fixed` | absent | `{id, name, kind: "fixed", decision: "<decision id>"}`, no `opts` | Options come from the decision. A proposed decision contributes its options; a decided or ratified one is locked to its choice and shows as a constraint. An option's id in the box is `<row id>-<letter>`. |
| `dims[]` of kind `fact` | absent | reserved: `{kind: "fact", from: {...}}` | The schema defines the shape and refuses it in version 1, with `record-schema-invalid` naming the row. Version 2 drops the refusal. |
| `dims[].constrains`, `dims[].reason` | absent | optional on an open row | What the decision from this row governs, and why its option was chosen. settle refuses a row with no `constrains`. |
| `rel` | required: per option a `why`, `notes`, and edge tuples `[target, "conf" or "req", why, tier?, src?]` | the same, with edges either here or in `edges` | An edge in `rel` gets the id `<from>:<to>`. Its `src` may be a string or a pin `{path, sha256}`. eagle-eye does not show an edge's `src`, and its validator only asks that one exists for a non-argued edge, so a pin passes it. |
| `edges` | absent | optional: an object keyed by edge id, each `{from, to, kind: "conflicts" or "requires", why, tier?, src?}` | chant's own form. Keyed by id so two editors adding edges rarely touch the same lines, and so a dissent can name one. A file holds its edges in `rel` or in `edges`, never both. eagle-eye reads only `rel`, so a box written this way renders there once grimoire reads `edges` too. |
| edge `tier` | optional, `argued` when absent | the same | None: `measured`, `sourced` or `argued`, and `argued` when absent. A `measured` or `sourced` edge must name its `src` in both. |
| `suspected` | optional | the same | None. chant never reads it as an edge. |
| `presets` | required, at least two, one of them changing an option | optional | A box without two presets is valid in chant and refused by eagle-eye's renderer. `box eval` reads it either way. |
| `tour` | optional | the same | None. |
| `evidence` | absent | optional, the decision's evidence grammar | Copied into each decision settle writes. Pins are checked as for any record. |
| `reviews` | absent | the decision's review entries, plus an optional `edge` on a dissent | A dissent may name the one edge it disputes by id. |
| `seal` | absent | optional, the author seal of #2688 | Signed by the author at `settle --sign`. |
| `settlement` | absent | written by settle: `{by, on, rev, decisions}` | `decisions` maps each settled row to the decision id it produced. |
| `closed_digest` | absent | written by settle | The closing seal, as a closed session's. |

The digest a verdict names leaves out `reviews`, `seal`, `state`, `settlement` and `closed_digest`. settle writes only those, so verdicts given on the proposed box still count on the settled one, and any other edit moves the digest. This is the one change to the digest rule: the `box` block names the fields settle writes, and `digestFields` leaves them out for this kind.

Ids follow eagle-eye's pattern, `^[a-z0-9][a-z0-9-]*$`, and are unique across the box. The reader checks what JSON Schema cannot: option ids unique across rows, exactly one `chosen` in each open row, every edge target an option in another row, no two edges between the same ordered pair, and every preset naming rows and options that exist. A failure is `box-structure-invalid`, and the record is not valid.

### The kind file

The reference kind ships beside the decision kind, data only, as the session and work kinds do:

```js
export const recordKind = {
  name: "box",
  location: { dir: ".", match: "^box-[0-9]{3,}-.+\\.box\\.json$" },
  format: "json",
  schema: { id: "urn:intentius:chant:box:1", path: "box.schema.json" },
  idField: "id",
  stateField: "state",
  states: ["proposed", "settled", "withdrawn"],
  closedStates: ["settled", "withdrawn"],
  pins: { field: "evidence" },
  reviews: { field: "reviews", decider: "author" },
  box: {
    decisions: "decision.kind.mjs",
    settledFields: ["state", "settlement", "closed_digest"],
    seal: "closed_digest",
  },
};
```

`box.decisions` names the decision kind whose records fixed rows reference and settle writes. The name ends in `.box.json`, the suffix eagle-eye's renderer strips when it names the page it writes beside the box (`<name>.local.html`).

## The lifecycle

| State | How it is reached | What may change |
|---|---|---|
| `proposed` | `chant workspace records new box --from <file>`, from a box written by hand or an eagle-eye file with the header fields added | Everything, through `records amend` or by hand. Each edit outside the settled fields moves the digest. |
| reviewed | `records review <box id>` while proposed; not a state of its own | Only `reviews`. The verdicts judge the configuration, so they sit on the box and not on the decisions. |
| `settled` | `records settle <box id>` | Nothing. The box is closed and sealed. |
| `withdrawn` | `records amend <box id>` with `state: "withdrawn"` | Nothing after. |

A settled box stays in the tree as the evidence of why its decisions were made together. Each decision it produced pins it by hash.

## One dial

The declaration's `quorum` is the only thing that differs between one person and a team. The decider's own verdict never counts (`review-decider`, #2676), so a workspace with one person sets `quorum: 0`, and its author settles with no reviews. From 1 up, the same box needs that many agree verdicts besides the author's.

The solo walk, in a workspace whose declaration says `"quorum": 0`:

```sh
chant workspace records new box --from box.json        # the declaration names the box kind
chant workspace box eval box-003                       # the verdict and findings as chosen
chant workspace box eval box-003 --set db=db-sqlite    # what a change breaks
chant workspace records amend box-003 --set dims.json  # move the chosen option
chant workspace records settle box-003 --by alice
```

The team walk, in a workspace whose declaration says `"quorum": 2`, is the same five commands with two reviews before the last:

```sh
chant workspace records review box-003 --verdict agree --by bob
chant workspace records review box-003 --verdict dissent --by carol --edge db-sqlite:deploy-fly \
  --note "fly volumes are per machine, so the edge is argued and wrong"
```

A dissent that names an edge points hud at that edge. An amend that fixes it moves the digest, so both verdicts stop counting and the reviewers look again. Sealed verdicts (#2691) apply unchanged: under `.chant/allowed_signers`, a verdict counts only when its seal verifies.

A project that grows from one person to a team edits one number in its declaration. The box files, the settled decisions and the commands stay as they are.

## `records settle`

`chant workspace records settle <box id> [--kind <box kind file>] --by <login> [--sign [<key file>]] [--dry-run]` settles one proposed box in one atomic write. It never commits.

It checks, in this order, and writes nothing when any check fails:

1. The box exists (`record-not-found`), is valid (the record's own reason code), and is proposed (`record-closed`).
2. `--by` is the box's `author` (`write-usage-invalid`). Another person who settles first amends `author`, which moves the digest and so asks for the reviews again.
3. No chosen option conflicts with another chosen option (`box-conflict-active`), and every requirement of a chosen option is chosen (`box-requirement-unmet`). This holds at every quorum, 0 included. Each refusal names the edge by id, its why and its tier.
4. Every fixed row names a decision that exists and is not superseded or withdrawn (`box-row-decision-unknown`, `box-row-superseded`).
5. The box's quorum is met under the workspace's `quorum` (`settle-quorum-unmet`, with the counted and uncounted verdicts). A quorum met with an open dissent settles, and the concern stays on the box.
6. Every decision it would write validates against the decision schema (`record-schema-invalid`, naming the row). A row with no `question` or no `constrains`, or a box with no `area`, stops here.

Every other finding is a warning and never blocks.

For each open row, in row order, it writes one decision record, with ids allocated as `records new` allocates them:

| Decision field | Written from |
|---|---|
| `id` | the next free id of the decision kind |
| `title` | the row's `name` |
| `state`, `decided_by`, `decided_on` | `"decided"`, `--by`, today |
| `area` | the box's `area` |
| `source` | `{kind: "box", box: "<box id>", row: "<row id>"}`, a third source form the decision schema gains |
| `question` | the row's `question` |
| `options` | the row's options in order, as `a`, `b`, `c`: `label` from `label`; `how` from the option's `how`, or else its `why` in `rel`; `tradeoff` from the option's `tradeoff`, or else a sentence per edge from it ("rules out <row>: <short>, because <why>"), or else "No edge in <box id> ties this option to another row." |
| `choice` | the chosen option's letter; `reason` from the row's `reason`, or else the chosen option's `why` followed by the whys of its active edges |
| `rejected` | every other option, with `why` from the edges that rule it out under the chosen set, each with its chain from the closure, or else "Not chosen in <box id>, and no edge rules it out." |
| `supersedes`, `reviews` | `[]` |
| `evidence` | the box's `evidence`, then the box file pinned by path and the sha256 of its settled bytes |
| `constrains` | the row's `constrains` |
| `seal` | with `--sign`, the author seal, as `records new --sign` writes it |

For each fixed row that names a proposed decision, it amends that decision to decided, choosing the row's selected option, as `records amend` would. A fixed row on a decided decision writes nothing.

Then it writes the box: `state: "settled"`, `settlement: {by, on, rev, decisions}` where `rev` is the commit it settled at, then `seal` with `--sign`, and last `closed_digest`, the SHA-256 of the file without `closed_digest`, by the session rule (`sessionSeal`). The decisions pin the box's final bytes, so the box is written before the pins are computed, and every file is written to a temporary name and renamed into place only when all of them are ready.

It prints `records-settle.schema.json`: the box id, its `closed_digest`, and each decision written or amended with its id, path, row and chosen letter. Its error codes are a closed list, `SETTLE_ERROR_CODES`, like `AMEND_ERROR_CODES`.

## The closure and `box eval`

`chant workspace records --kind box.kind.mjs --json` gives each box a `closure`, computed once, by chant, over the whole box and not a selection. For every option it lists the options it rules out and the options it requires, directly and through chains, each with the edge ids that derive it:

```json
"closure": {
  "write-role": {
    "rulesOut": [{ "option": "lb-owner", "chain": ["write-role:lb-owner"] }],
    "requires": []
  },
  "mount-all": {
    "rulesOut": [{ "option": "write-open", "chain": ["mount-all:read-all", "read-all:write-open"] }],
    "requires": [{ "option": "read-all", "chain": ["mount-all:read-all"] }]
  }
},
"cycles": []
```

Chains compose by eagle-eye's rule. A `requires` edge carries a chain forward, and one `conflicts` edge closes it; a `conflicts` edge never starts a chain, because it removes its target and the target's own edges never fire. A conflict holds in both directions. A loop of `requires` edges is listed once in `cycles`. A click in hud's grid is then a lookup in `closure`.

Findings that depend on a selection come from a read-only command, eagle-eye's `--sel`:

```sh
chant workspace box eval <box id> [--set <row>=<option> ...] [--json]
```

It prints the verdict (`as chosen`, `consistent`, `incomplete` or `does not hold`), each active conflict and unmet requirement with its edge, the options the selection rules out, and the findings below. It also reports the most connected option and the weakest active edge as data, which hud may show; neither is a finding code. With a fixed row it expands the decision's options inline, and `--expand` prints the box in eagle-eye's shape, fixed rows expanded, for its renderer. Its output schema is `box-eval.schema.json`.

## Finding codes

The codes are closed, like every reason code. Each gets a row in `docs/data/boundary.yaml`, and they join `REASONS` within contract 1, as the work codes (#2683) and the review reasons (#2676) did.

The nine in #2698:

| Code | Where | Meaning |
|---|---|---|
| `box-conflict-active` | `records` on a proposed box, `box eval`, a settle refusal | Two selected options are joined by a conflicts edge. |
| `box-requirement-unmet` | the same | A selected option requires an option that is not selected. |
| `box-row-unlinked` | `records`, `box eval` | A row has no edge in or out, so it is independent or an edge is missing. |
| `box-strawman-unrejected` | `box eval` | A strawman option that nothing selected rules out. |
| `box-argued-only` | `box eval` | A row whose active edges are all argued. |
| `box-chain-unstated` | `records`, `box eval` | The closure derives a relation that no edge states. |
| `box-cycle` | `records`, `box eval` | Options that require each other. |
| `box-row-superseded` | `records` on a settled box, a settle refusal for a fixed row | A decision the box produced or references was superseded by a decision outside the box. |
| `box-edge-evidence-drifted` | `records` | A measured or sourced edge pins a file whose bytes changed or that is gone. |

Three more are structural, and each makes the record invalid. #2698 does not list them, so lex00 decides them with the rest:

| Code | Meaning |
|---|---|
| `box-structure-invalid` | A check JSON Schema cannot make failed: duplicate option ids, not exactly one chosen option in an open row, an edge to an unknown option or to its own row, two edges between one ordered pair, edges in both `rel` and `edges`, or a preset naming a row or option that does not exist. |
| `box-row-decision-unknown` | A fixed row names a decision that does not exist. |
| `box-seal-mismatch` | A settled box's `closed_digest` is not the digest of its text, so it changed after it settled. |

eagle-eye's eight weakness patterns stay human. A dissent may name one in its note, and an optional agent audit writes the `suspected` list. chant never scores reasoning. eagle-eye's `row not opened` reads a reader's clicks and belongs to hud.

## Coupled drift

A settled box's edges tie each chosen option to its siblings. When one of its decisions is later superseded on its own, `records` reports `box-row-superseded` on the box, naming the row, the old decision and the new one.

`graph --intent` reports `intent-decision-coupled-stale` on any region that a live sibling decision constrains, naming the superseding decision, the decision it replaced, the sibling and the ids of the edges between the replaced option and the sibling's choice. It stops firing when the sibling is superseded as well, or when a later settled box holds the new decision and the sibling as rows together. A work item names it in `source.finding`, with the sibling's path as `source.region`, and `work-done-gap-open` applies unchanged. The work schema's finding enum gains the code.

A `measured` or `sourced` edge whose `src` pins a file reports `box-edge-evidence-drifted` on the box when that file changes or goes missing, by the rule that gives a decision `asset-drift`.

The intent walk continues from a file's decision into its box. The graph gains a `box` node kind and a `settled-in` edge from each decision to the box it came from. A walk that reaches a decision settled in a box brings in the box, its rows, and the active edges that touch that decision's chosen option, so the answer to why a file is this way can say that the database row chose one option, and that option required this one here.

## The worked example: hud#613

[alecraso/hud#613](https://github.com/alecraso/hud/pull/613) integrated the chant stack into hud and made eleven decisions, one at a time. [`examples/hud-613-integration.box.json`](examples/hud-613-integration.box.json) draws them as a box. It carries the chant header fields (`schema`, `id`, `state`, `author`, `area`, each row's `kind` and `constrains`, `evidence`, `reviews`) and passes eagle-eye's renderer at grimoire 1a5dad20.

How the eleven became rows:

| hud#613 decision | In the box |
|---|---|
| 1. chant MCP tools auto-approved, `op-run` and `op-approve` included | the row "Approval of chant's MCP tools", with the row "Gate approval over MCP" for chant's rule (#2384) that makes it safe |
| 2. one rule for reads; every chant write behind a verified player | split into two rows, "Spectator reads" and "Guard on chant writes", because a set can change one without the other; the rule it rests on, that an unsigned loopback request counts as the owner, is the row "Unsigned loopback request" |
| 3. `via: unlinked` matches offered, tagged | dropped: no change, the code already did it |
| 4. deploys target chant's default environment | dropped: no change, the code already did it |
| 5. `HUD_CHANT_RECORD_KINDS` is an override only | dropped: a documentation choice, the README says the rule once |
| 6. signing is owner-only | the row "Who seals a verdict", with the row "Key the daemon signs with" that its reason names |
| 7. #609 stays as built | merged into the row "What the gear menu links"; its details are notes on the chosen option |
| 8. start writes the verified player's roster name as owner | the row "Name on a started work item"; the done and drop rules are chant's work rules and stay out |
| 9. a verdict in a session is not limited to the agenda | dropped: no edge to any other row, so it is decided alone |
| 10. the chant pin stays at 0.87.0 | dropped: a release step with no edge to the access rules |
| 11. mount everything #609 mounts | merged with 7 into "What the gear menu links" |

That gives nine rows, 26 options, eleven edges (six sourced, five argued) and a strawman in every row. The sourced edges cite hud's code at the merge commit, da097e6, or the PR's own decisions. One argued edge failed the audit and sits in `suspected`, as `insufficient`: with no chant tools and every write verified, the agent has no way to deploy, which is a conflict only if some row required the agent to deploy, and none does.

The reading, from `node render.mjs examples/hud-613-integration.box.json --check`:

```text
ok: Who may do what in hud's chant views — 9 decisions, 26 options, 11 edges (5 argued), 9 strawmen
problem: hud now shows chant's decisions, intent, work and sessions, and it can deploy, review and seal. The integration made eleven decisions about these, one at a time. Most of them are one question: which request may read, which may write, and whose name a write records. A request on loopback with no identity header counts as the owner, and several answers are safe only because of that rule. This box draws those answers together, so a later change to one of them shows what it breaks.
who: The owner of a hud box, the players and spectators who join through the proxy, and the agent that runs on the same machine.
when: Decided on 2026-09-25 in alecraso/hud#613. The box is drawn afterwards, as evidence for the chant design.
verdict: as chosen
  most connected: Spectator reads: Every view has 2 edges to the other selected options. If you change this option, the most options change with it.
  strawman not rejected: Unsigned loopback request: A spectator; Who seals a verdict: Only in chant; Name on a started work item: No owner; Approval of chant's MCP tools: No chant tools; What the gear menu links: Deploy only. No selected option rules these strawmen out. Give the reason to reject them, or pick one.
  chain: What the gear menu links: All four pages rules out Guard on chant writes: No guard, through Spectator reads: Every view. The box does not state it. Add the edge, or say in the notes why the path is enough. The weakest edge on the path is argued.
  evidence for the verdict: 1 of 4 active edges is argued. Nobody measured that one. The active edges at Spectator reads, What the gear menu links are all argued. Measure those rows first. If all the edges are true, the verdict is “as chosen”. If one argued edge is false, the verdict can change.
```

The break test (`--sel "eagle-eye: write-role"`) sets the role check in place of the verified guard. The verdict becomes "does not hold": the role check conflicts with the loopback rule, and both sealing and the work item's owner require the verified guard. All three edges are sourced from hud's code. That is the coupling #2698 describes: the write guard, the seal rule and the owner rule hold together only because an unsigned loopback request counts as the owner.

The loopback preset (`--sel "eagle-eye: lb-spectator, write-role"`) is the configuration nobody wrote in hud#613. With an unsigned loopback request as a spectator, the role check no longer conflicts with anything, and the verdict is "incomplete" only because sealing and the owner rule still require the verified guard. The strawman finding names it too: nothing in the box rules out the loopback spectator. What rules it out is the chat on a direct localhost page (hud#186), which no row draws, and the note on that option says so.

The chain finding says the gear menu's links rule out an unguarded write, through the spectator read rule. The note on "All four pages" says the path is enough, since a link is not why a write needs a guard. As chant data, the same relation is `closure["mount-all"].rulesOut`, and `box-chain-unstated` would report it the same way.

Settled under chant, the box would write eight decisions, one for each row but the gate row, which chant decided in #2384 and which would be a fixed row once a chant decision records it.

## Implementation issues

In landing order. Each is usable once it lands, without the ones after it.

### 1. workspace: the box record kind and its schema

The box kind file and `box.schema.json` ship beside the decision kind, and the reference workspace carries one. `records new`, `amend` and `review` write JSON records, which they refuse today for any kind whose format is not Markdown (`open` in `records-write.ts`): a JSON write keeps the member order and indentation of the file and changes only the members it sets, so the digest rule of ws-053 holds. The kind contract gains the `box` block, `digestFields` leaves out its `settledFields`, and the reader makes the structural checks. `records review` takes `--edge <id>` on a dissent and refuses an id the box does not have.

Acceptance criteria:
- A box with open rows only, and one with a fixed row on a decided decision, read valid, with fixed options expanded in the output.
- An eagle-eye box with the header fields added reads valid with no other change, its edges given ids `<from>:<to>`.
- Each `box-structure-invalid` case, a fixed row naming no decision (`box-row-decision-unknown`) and a fact row (`record-schema-invalid`) is refused, each naming the row, option or edge.
- `records new`, `amend` and `review` write a JSON box; an amend of an edge moves the digest, and a review does not.
- The decision kind's output is unchanged, and the boundary roster has rows for the kind and each new code.

### 2. workspace: `records settle`

`records settle` as written above, with `records-settle.schema.json`, `SETTLE_ERROR_CODES` and the decision schema's third source form, `{kind: "box", box, row}`.

Acceptance criteria:
- At quorum 0 the author settles with no reviews; at quorum 2 settle refuses with `settle-quorum-unmet` until two other people agree on the current digest, and a verdict on an older digest does not count.
- A chosen set with a conflict, or an unmet requirement, is refused at quorum 0 and at quorum 2, naming the edge.
- A settle writes one valid decided record per open row, each pinning the settled box at its final hash, amends a proposed decision named by a fixed row, and closes and seals the box; reading the box afterwards gives no `box-seal-mismatch`.
- A settle that fails at any check leaves every file as it was, and one whose last write fails leaves no partial set.
- `--sign` seals each decision and the box with the author seal of #2688.

### 3. workspace: the closure and `box eval`

`records --json` gives each box `closure` and `cycles`, and `chant workspace box eval <id> [--set ...] [--expand] [--json]` prints the verdict and findings for a selection, with `box-eval.schema.json`.

Acceptance criteria:
- On the hud#613 example, `box eval` gives the verdict and the conflicts, unmet requirements, strawmen and chain that eagle-eye's `render.mjs --check` and `--sel` give for the same selections.
- A chain that starts with a conflicts edge derives nothing; a loop is reported once in `cycles`.
- `--expand` prints a box that eagle-eye's renderer accepts, fixed rows included.
- `box eval` writes nothing, and runs at `--at`.

### 4. workspace: coupled drift findings

`records` reports `box-row-superseded` and `box-edge-evidence-drifted`; `graph --intent` adds the `box` node, the `settled-in` edge and `intent-decision-coupled-stale`; the work schema's finding enum gains the code.

Acceptance criteria:
- Superseding one decision of a settled box reports `box-row-superseded` on the box and `intent-decision-coupled-stale` on a region its sibling constrains, naming the edges.
- The finding stops when the sibling is superseded too, or when a new settled box holds both as rows.
- A work item with that `source.finding` reads as addressing the finding, and `work-done-gap-open` fires while it is done and the finding still fires.
- Editing a file pinned by a sourced edge reports `box-edge-evidence-drifted`.

### 5. alecraso/hud: a box view

A consumer issue in hud. The view reads `records --json` and `box eval`, renders the grid, the presets and the coach step (predict before reveal), and writes only through `records new`, `amend`, `review` and `settle`. It follows ws-052: it parses no box file and computes no closure.

Acceptance criteria:
- A click on an option shows what it rules out and requires from `closure` alone, with no request.
- A selection other than the chosen set shows `box eval`'s verdict and findings.
- A dissent can name an edge, and the settle button shows chant's refusal with the edge.
- jhgaylor/chud needs no change.

### 6. arugula-salad/studio: the smoke proof

The studio smoke gains a box over three rows, settled, one row then superseded on its own.

Acceptance criteria:
- The smoke settles the box at quorum 0 and reads three decided records with `source.kind: "box"`.
- Superseding one of them shows `box-row-superseded` on the box and `intent-decision-coupled-stale` on a sibling's region.
- A work item raised from that finding reads as addressing it.
