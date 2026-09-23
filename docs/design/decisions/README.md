# Decision files

Each file in this directory records one design decision. The format comes from [#2555](https://github.com/INTENTIUS/chant/issues/2555), and any epic can use it. The first set is the workspace design, [#2524](https://github.com/INTENTIUS/chant/issues/2524), with ids `ws-001` to `ws-050`, one per row of its Decisions table.

All of the `ws-` decisions are in state `decided`. One maintainer chose each of them, and they bind nobody until a group reviews and ratifies them as #2555 describes. The states and their transitions are drawn in [decision-states.md](../decision-states.md).

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

## Fields

| Field | Holds |
|---|---|
| `schema` | the format version, `1` |
| `id` | a stable id: a lowercase prefix for the epic, a dash and three digits. Ids are never reused or renumbered |
| `title` | the topic as the source table names it |
| `state` | `proposed`, `decided`, `ratified`, `superseded` or `withdrawn` |
| `area` | the design section, such as `D4`; the review queue groups by it |
| `source` | the issue, the table row verbatim and the revision marker on that row, if any |
| `question` | one sentence |
| `options` | every option, the chosen one included, each with a letter id, the table's label, how it works (`how`) and its trade-off (`tradeoff`) |
| `choice` | the chosen option's id and the reason |
| `rejected` | each option not chosen, with why it lost |
| `supersedes` | earlier choices this decision replaced |
| `evidence` | public links to the design sections, issues and audits behind it |
| `decided_by`, `decided_on` | the forge login and the date |
| `reviews` | each reviewer's verdict (`agree`, `dissent` or `abstain`), a note and a date; empty until a review happens |
| `constrains` | the issues (`owner/repo#n`), decisions (their ids) or members (`member:<name>`) the decision governs |

Unknown fields are refused, except ones starting with `x-`.

## Values

The front matter uses only the value types YAML and JSON share. Every string is double-quoted with JSON escapes. Quoting keeps YAML's implicit typing from reading `2026-09-23` as a timestamp. #2524 D4 requires this so a file can be hashed as JSON and sealed once it is ratified. Anchors, tags and multi-document streams are out.

## Revisions

The workspace design went through eight revisions before any files existed, and the v8 audit changed several earlier choices. A row marked `(v8)` keeps its marker in `source.revision`. When the table names the earlier choice, for example `accept and show (v6)`, that option stays in `options` with `chosen_in: "v6"`. It is listed under `rejected`, and `supersedes` points at it:

```yaml
supersedes:
  - revision: "v6"
    option: "b"
```

`choice.reason` then says that the choice was revised and why. Once decision files exist, a new decision that replaces an older file names it instead, as `- decision: "ws-012"`. The old file is never edited to point forward. A reader derives that link from the new file, as #2524 D4 does for records.

## Reviews

A review adds entries to `reviews` through a pull request. It never edits the choice. Merging a pull request that brings a decision to its quorum (by default two distinct reviewers besides the decider, #2555) changes `state` to `ratified`. A dissent can name a new `proposed` decision in `proposes`.

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
