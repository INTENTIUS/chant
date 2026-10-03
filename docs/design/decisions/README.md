# Decision files

Each file in this directory records one design decision. The format comes from [#2555](https://github.com/INTENTIUS/chant/issues/2555), and any epic can use it. The first set is the workspace design, [#2524](https://github.com/INTENTIUS/chant/issues/2524), with ids `ws-001` to `ws-050`, one per row of its Decisions table. Later workspace decisions continue the sequence: `ws-051` records how examples and fixtures are declared ([#2556](https://github.com/INTENTIUS/chant/issues/2556)), `ws-052` records the boundary between chant and hud ([#2657](https://github.com/INTENTIUS/chant/issues/2657)), `ws-053` records the record formats a kind may read beyond Markdown front matter ([#2664](https://github.com/INTENTIUS/chant/issues/2664)), and `ws-054` proposes a box record kind for decisions that constrain each other, settled into decision records ([#2698](https://github.com/INTENTIUS/chant/issues/2698)). Then `ws-055` puts what a development model tracks in the workspace's ledgers ([#2717](https://github.com/INTENTIUS/chant/issues/2717)), `ws-056` says where the chud lexicon's parts go when chud retires ([#2713](https://github.com/INTENTIUS/chant/issues/2713)), `ws-057` divides the factory's builds on Fountain between the spec and the thin layer ([#2714](https://github.com/INTENTIUS/chant/issues/2714)), `ws-058` records decision points over the workspace graph ([#2723](https://github.com/INTENTIUS/chant/issues/2723)), `ws-059` records who keeps a member's graph between reads ([#2876](https://github.com/INTENTIUS/chant/issues/2876)), `ws-060` records the telemetry attributes a workload carries and the link that says where its telemetry goes ([#2558](https://github.com/INTENTIUS/chant/issues/2558)), `ws-062` records what `check --live` resolves links against and the built-in `design` member kind ([#2549](https://github.com/INTENTIUS/chant/issues/2549)), `ws-063` keeps the review digest and the whole-file seal as two hashes ([#2546](https://github.com/INTENTIUS/chant/issues/2546)), `ws-064` makes this directory's kind file the decision kind's specification, which a plugin carries as a copy ([#2555](https://github.com/INTENTIUS/chant/issues/2555)), `ws-067` records the write scope per member and record kind and the agent sessions bound to one member, and `ws-068` keeps chant's lifecycle ledgers as ledgers rather than record kinds ([#2548](https://github.com/INTENTIUS/chant/issues/2548)). `ws-074` makes the repo the database: every durable fact about a workspace is a file in it, written only through chant, and a tool keeps only caches ([#3158](https://github.com/INTENTIUS/chant/issues/3158)). `ws-075` names chant's commit trailers, `Chant-Lease`, `Chant-Run`, `Chant-Record` and `Chant-Applied-*` beside ws-067's `Chant-Agent`, which replace studio's `Studio-*` and `Factory-*` trailers ([#3149](https://github.com/INTENTIUS/chant/issues/3149)). `ws-076` keeps each agent run's record, its cost and the commits it made, in a run ledger on `chant/lifecycle` written through `chant workspace runs` ([#3033](https://github.com/INTENTIUS/chant/issues/3033)). `ws-077` puts a box's factory and listing on its box block, with what a build may not change in `writeScope.<class>.protected` and plantable as a fact the read contract prints, replacing studio's `x-factory` ([#3146](https://github.com/INTENTIUS/chant/issues/3146)). `ws-078` takes a reader from a line or a symbol to the decisions governing it and the agent run that wrote it, through `graph --intent path#symbol` and the document's `why` answer ([#3034](https://github.com/INTENTIUS/chant/issues/3034)). `ws-079` lets a pinned package name principal classes at a data-only `./workspace-principals` subpath, each the holders of one role at base, for `writeScope` to restrict, failing closed on a class nothing supplies ([#3080](https://github.com/INTENTIUS/chant/issues/3080)). `ws-080` names a person in a record or gate approval by a forge identity or a signer principal, which the surface that signed them in passes to chant, and adds the declaration's `identity` block: `attribution: "identified"` refuses a roster name, and `gates` counts only an approval sealed with `chant approve --sign` by a signer from a declared class ([#3163](https://github.com/INTENTIUS/chant/issues/3163)). `ws-081` has a release deploy add `service.version` and `vcs.ref.head.revision` to a workload through one variable, `CHANT_RELEASE_ATTRIBUTES`, that the generated output references and the deploy step fills, so the committed files do not change with a release ([#3061](https://github.com/INTENTIUS/chant/issues/3061)).

The `ws-` decisions are in state `decided`, except `ws-054`, which is `proposed`. A decision can start as `proposed`, listing its options with a recommendation in an `x-` field such as `x-recommendation` and a null `choice`. It becomes `decided` when the maintainer sets `state`, `choice`, `decided_by` and `decided_on`, removes the recommendation, keeps every rejected option under `rejected`, and `node scripts/import-decisions.mjs --check` passes. `ws-053` went that way, and pins its design note by hash in `evidence`. One maintainer chose each decided one, and they bind nobody until a group reviews and ratifies them as #2555 describes. The states and their transitions are drawn in [decision-states.md](../decision-states.md).

## A file

A decision is a Markdown file named `<id>-<slug>.md`. The front matter is the record, and [decision.schema.json](decision.schema.json) defines it. The body below the front matter holds a title and any links to diagrams, and readers should not expect anything else there.

```markdown
---
schema: 1
id: "ws-003"
title: "Seal scope"
state: "decided"
area: "D4"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Seal scope"
  revision: null
question: "What part of a record file does a seal cover?"
options:
  - id: "a"
    label: "whole file"
    how: "..."
    tradeoff: "..."
  - id: "b"
    label: "in-file regions"
    how: "..."
    tradeoff: "..."
choice:
  option: "a"
  reason: "..."
rejected:
  - option: "b"
    why: "..."
supersedes: []
evidence:
  - title: "#2524 D4. Records"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d4-records"
    as_of: "2026-09-23T20:56:42Z"
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2546"
---

# Seal scope
```

A decision can also be written through chant: `chant workspace records new`, `amend` and `review` write a decision file after validating it, allocate the next id and bind each review to the digest of the text it judged ([#2670](https://github.com/INTENTIUS/chant/issues/2670), described in [chant workspace records](https://intentius.io/chant/cli/workspace-records/#writing-records)). A UI such as hud writes decisions only that way.

## Fields

| Field | Holds |
|---|---|
| `schema` | the format version, `1` |
| `id` | a stable id: a lowercase prefix for the epic, a dash and three digits. Ids are never reused or renumbered |
| `title` | the topic as the source table names it |
| `state` | `proposed`, `decided`, `ratified`, `superseded` or `withdrawn` |
| `area` | the design section, such as `D4`; the review queue groups by it |
| `source` | where the decision was first recorded: an issue's table row, the workspace member it was made in, or the harness session it was proposed in (see [Source](#source)) |
| `question` | one sentence |
| `options` | every option, the chosen one included, each with a letter id, the table's label, how it works (`how`) and its trade-off (`tradeoff`) |
| `choice` | the chosen option's id and the reason |
| `rejected` | each option not chosen, with why it lost |
| `supersedes` | earlier choices this decision replaced |
| `evidence` | the design sections, issues, audits and workspace files behind it: each a public link or a file pinned by hash (see [Evidence](#evidence)); may be empty |
| `decided_by`, `decided_on` | the forge login and the date |
| `proposed_by` | who proposed the decision, when `chant workspace records new --by <name>` or the MCP `records-new` tool's `by` named one for a decision that opened `proposed`; null or absent otherwise, and never cleared once set (see [Naming a proposer](#naming-a-proposer)) |
| `closed_digest` | the whole-file seal, written when the decision enters a closed state (`ratified` or `superseded`); absent before that (see [Reviews](#reviews)) |
| `reviews` | each reviewer's verdict (`agree`, `dissent` or `abstain`), a note, a date and the digest of the text it judged; a dissent must have a note; empty until a review happens |
| `constrains` | the issues (`owner/repo#n`), decisions (their ids), members (`member:<name>`) or workspace files and directories (`path:<path>`) the decision governs; at least one, since a decision that governs nothing is refused |
| `out_of_scope` | optional: workspace files or directories a change carrying the decision out must not touch; `chant workspace check --changes` reports a change to one as `change-out-of-scope` while the decision is in hand ([#2773](https://github.com/INTENTIUS/chant/issues/2773)) |

Unknown fields are refused, except ones starting with `x-`.

## Source

`source` takes one of three forms. A decision taken from an issue's decisions table names the issue, the row's topic cell verbatim and the revision marker on that row, as the `ws-` decisions do:

```yaml
source:
  issue: "INTENTIUS/chant#2524"
  row: "Seal scope"
  revision: null
```

A decision made in the workspace itself, such as one a product's design app records while someone works on a screen, often has no issue behind it ([#2654](https://github.com/INTENTIUS/chant/issues/2654)). Its source names the member it was made in, with `kind: "workspace"`:

```yaml
source:
  kind: "workspace"
  member: "app"
  session: "S-0001"
```

`member` is the member's name in the workspace declaration. `session` is the id of the session the decision came from, in whatever form the member gives it, and it may be `null` or left out. `issue` may be added when an issue does relate to the decision, and it is never required in this form. Beyond the proposal fields below, the form takes no other fields, so a `row` or `revision` belongs to the issue form only.

A decision proposed in a harness session, with no issue row or member behind it, has a third form, which names how it arrived in `via` ([#2708](https://github.com/INTENTIUS/chant/issues/2708)):

```yaml
source:
  via: "mcp"
  client:
    name: "claude-code"
    version: "2.1.0"
  harness: "claude-code"
  model: "claude-opus-5-5"
  session: "0f4c2a"
  turns:
    from: 12
    to: 18
  transcript:
    path: "~/.claude/projects/app/0f4c2a.jsonl"
    sha256: "<64 hex digits>"
```

The same fields may be added to either of the other forms, to say where the proposal came from. `via` is `cli`, `mcp` or `harvest`. `client` is the MCP client's `clientInfo`, or the CLI. `session` is the harness's session id, or `{ id, record }` with the chant session record it was held in. `transcript` pins the conversation by a `path` or `uri` and the SHA-256 of its bytes, and is never a copy of it. Every field is optional, none is trust, and a harvested decision (`via: "harvest"`) is written `proposed`. The kind opts in with `source: { field: "source" }`; [`chant workspace records`](https://intentius.io/chant/cli/workspace-records/#where-a-proposal-came-from) describes the checks.

## Naming a proposer

`chant workspace records new --by <name>` and the MCP `records-new` tool's `by` name who is proposing the decision ([#2756](https://github.com/INTENTIUS/chant/issues/2756)). Since a new decision opens `proposed`, `by` is written to `proposed_by`, apart from `decided_by`, which stays null until a person decides it through an amendment. `by` is written to `decided_by` instead only when the fields given with `--from` open the decision straight into a later state, such as `decided`, which only `chant workspace records new` at the CLI can do; a record made through the MCP tool always opens `proposed`. `records amend` and `records-amend` take no `by`: a person names a decider in the fields given to `--set`, such as `decided_by`, the way they always have. `proposed_by` is never cleared once written, including once the decision is decided, ratified or superseded, and `--sign` still seals `decided_by`, not `proposed_by`: a proposal with no decider yet has no author to seal.

The kind opts in with `proposedBy: { field: "proposed_by" }`; a kind that leaves it out keeps `by` writing `reviews.decider` for every new record, as it always has.

## Evidence

An `evidence` entry takes one of two forms. A public link has `title` and `url`, with `as_of` and `sha256` optional:

```yaml
  - title: "#2524 D4. Records"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d4-records"
    as_of: "2026-09-23T20:56:42Z"
```

A file in the workspace, such as a screen spec in the design member, has `title`, `path` and `sha256`, with `as_of` optional (#2549):

```yaml
  - title: "The home screen spec"
    path: "design/screens/home.json"
    sha256: "074e55f524703fe65ecba4cf0e2cd3200e21f969a1f789618e22ff9537dd99e0"
```

`path` starts at the workspace root and sits inside a member. It uses `/` and has no leading `/`, no `.` or `..` segment and no trailing `/`. `sha256` is the lowercase hex SHA-256 of the file's bytes, and it is required. `chant workspace records pin <path>` prints both, and `sha256sum <path>` from the workspace root gives the same hash. An entry never has both `url` and `path`.

`chant workspace records` checks each pin against the files it reads. A file that changed is reported as `asset-drift` and one that is gone as `asset-missing`. When a decision supersedes another and pins a file at the hash the old one pinned, while the file has not changed since, it is `asset-stale`: the decision changed and the artifact did not follow. All three are warnings: the decision stays valid, and the finding asks for it or the artifact to be revisited. Accepting the new file means updating `sha256` in a pull request.

`evidence` may be an empty list, for a decision that cites nothing and pins no file, such as a choice made in a design session with no research behind it. The record is still valid, and `chant workspace records` gives it the warning `record-no-evidence` so a reviewer sees that nothing backs it. A decision that constrains nothing is different: an empty `constrains` fails the schema, and the record is invalid.

`constrains` takes `path:<path>` with the same grammar as an evidence path, for a decision that governs a file or directory rather than a whole member, such as `path:app/src/server.mjs`. Relationships between artifacts and the code they shape come from decisions only: a reader goes from a file to the decisions whose `constrains` cover it, and from those to the files their evidence pins. The [read contract](https://intentius.io/chant/reference/workspace-read-contract/#record-links-and-artifacts) describes that walk.

## Values

The front matter uses only the value types YAML and JSON share. Every string is double-quoted with JSON escapes. Quoting keeps YAML's implicit typing from reading `2026-09-23` as a timestamp. #2524 D4 requires this so a file can be hashed as JSON and sealed once it is ratified, which `closed_digest` does. Anchors, tags and multi-document streams are out.

## Revisions

The workspace design went through eight revisions before any files existed, and the v8 audit changed several earlier choices. A row marked `(v8)` keeps its marker in `source.revision`. When the table names the earlier choice, for example `accept and show (v6)`, that option stays in `options` with `chosen_in: "v6"`. It is listed under `rejected`, and `supersedes` points at it:

```yaml
supersedes:
  - revision: "v6"
    option: "b"
```

`choice.reason` then says that the choice was revised and why. Once decision files exist, a new decision that replaces an older file names it instead, as `- decision: "ws-012"`. The old file is never edited to point forward. A reader derives that link from the new file, as #2524 D4 does for records. The link takes effect under an equal or stricter approval rule: a `decided` decision replaces a `decided` or `proposed` one, a `ratified` one replaces any, and a `proposed` one replaces nothing until it is decided.

## Reviews

A review adds entries to `reviews` through a pull request. It never edits the choice or the state. Once a decision's quorum is met (by default two distinct reviewers besides the decider, #2555), a person sets `state` to `ratified` with `chant workspace records amend`, in a pull request of its own or in the one that carries the last verdict. Below the quorum the amendment is refused with `ratify-quorum-not-met` (#2873). The digest leaves `state` out, since the kind names `ratified` in `reviews.ratified`, so the verdicts still count on the ratified decision. A dissent can name a new `proposed` decision in `proposes`.

A dissent needs a reason. Its `note` must be a non-empty string, while `agree` and `abstain` may leave `note` out or set it to null. `chant workspace records` reports a dissent with no note as `record-schema-invalid`, naming the reviewer, and the record is not valid (#2652).

Each dissent is a concern, and it stays open until it is addressed or withdrawn. `addressed_by` links the answer from the decider or the group: a decision id, an issue or pull request as `owner/repo#n`, or an `https://` link. Addressing a concern means answering it, which does not have to mean accommodating it (RFC 7282, section 3). `withdrawn_on` is the date the concern's author withdrew it, and only that author withdraws it. The schema cannot check who made a change, so review of the pull request enforces that. Only a dissent carries these two fields.

A verdict given in a review session names it in `session`, as `session: "S-0002"` (#2673). The session is its own record, of the session kind in the reference workspace's design member (`reference-workspace/design/sessions/session.kind.mjs`). It keeps the agenda, who attended with each principal's class (`person` or `agent`), when it opened and closed, and the same verdicts, each naming the decision it judged. It is sealed when it closes. `chant workspace records` on the session kind checks the seal and that each verdict's decision exists, and lists on each session the review entries that name it (`citedBy`). An agent may attend a session to prepare it, and never gives a verdict. `chant workspace records --since <open commit> --at <close commit>` on either kind lists what the session changed: new verdicts, state transitions, new decisions and supersessions.

A verdict names the record's `digest`, which `chant workspace records --json` prints for each record: the SHA-256 of the file without its `reviews` block, its top-level `seal` block (#2688), its `state` line (#2873) and, once it is sealed, its `closed_digest` line (#2546). Any edit outside those changes the digest, so a verdict given before an amendment stops counting and the reviewer has to look again (#2672). A verdict with no digest still counts, and `records` warns `review-undigested`. `chant workspace records review` writes a verdict with the digest and changes only the `reviews` block, so it never moves the digest itself.

`chant workspace records --json` computes each decision's quorum (#2671). It counts distinct reviewers, after trimming and lower-casing their names, so a reviewer listed twice counts once. It never counts the decider, an agent, a verdict on an older digest, or, once an attestation policy is active, a verdict without a seal that verifies. The quorum is met when the counted `agree` verdicts reach the workspace's `quorum`, two by default. A met quorum with an open dissent is met with objections, not consensus. The rules are on the [`records` page](../../src/content/docs/cli/workspace-records.mdx#reviews-and-quorum).

A reviewer seals a verdict with `chant workspace records review <id> --verdict agree --by <principal> --sign`, which signs it with the ssh key git signs commits with, or with the key file given after `--sign` (#2687). The seal is a `seal` object on the entry, `{signer, key, signature}`. The signature covers the record id, the verdict's digest, the verdict, the reviewer and `on`, so it binds the verdict to the text it judged. Once `.chant/allowed_signers` exists on the target branch, a verdict counts only when its seal verifies for its reviewer against that file, and `records --json` says why each other verdict doesn't, in `attested` and `attestation`. So `--by` must be the principal the file names for the reviewer's key. Until the file exists, seals are reported and don't change what counts. The steps are under [Sealing a verdict](../../src/content/docs/cli/workspace-records.mdx#sealing-a-verdict).

A decider seals the decision itself with `chant workspace records new --sign` or `chant workspace records amend <id> --sign` (#2688). The seal is a top-level `seal` object, `{signer, key, signature}`, signed by `decided_by` over the id, the digest, `decided_by` and `state`. The digest leaves `seal` out along with `reviews`, so a decision without one has the digest it always had. An amendment moves the digest: `amend --sign` signs again, and `amend` without `--sign` removes the seal. Under `.chant/allowed_signers` on the target branch, a decision with `decided_by` and no seal that verifies is read with the warning `record-unattested`. It still counts, since sealing decisions is opt-in. A proposed decision has no `decided_by`, so it has no author to seal. The steps are under [Sealing a record](../../src/content/docs/cli/workspace-records.mdx#sealing-a-record).

A decision that enters a closed state through `chant workspace records amend` or `new` also gets its whole-file seal in `closed_digest` (#2546, [ws-063](ws-063-seal-and-review-digest.md)). The seal is `sha256:` and the SHA-256 of the RFC 8785 (JCS) form of the front matter without `closed_digest`, as `core`, and the text below it, as `body`, with line endings normalised. It covers everything the digest leaves out: the reviews, the author seal and the state. The digest leaves `closed_digest` out in turn, so the verdicts that ratified a decision still count once it is sealed. `chant workspace records` reports a sealed decision that changed afterwards as `record-seal-mismatch`. Without an attestor, seals detect accidental edits only: anyone can recompute one. The rule and a hand check are under [Seals on closed records](../../src/content/docs/cli/workspace-records.mdx#seals-on-closed-records).

## Importing from an issue

Other epics keep their decisions in issue tables today. [`scripts/import-decisions.mjs`](../../../scripts/import-decisions.mjs) turns such a table into drafts:

```sh
node scripts/import-decisions.mjs --issue INTENTIUS/chant#2524 --prefix ws \
  --decided-by lex00 --decided-on 2026-09-23
```

It reads the table under a `Decisions` heading, or the heading `--heading` names. The header row must name a topic column, and it must also have columns for the choice and for what was rejected. Rejected cells split on `;`. The `(vN)` markers become `source.revision`, `chosen_in` and `supersedes` entries. The drafts leave the question, the reasons and each option's working and trade-off as `null`, for someone to write from the design text. The script never overwrites an existing file without `--force`.

Check every file against the schema, and the ids and option references across files:

```sh
node scripts/import-decisions.mjs --check
```
