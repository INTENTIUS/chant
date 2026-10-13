---
schema: 1
id: "ws-076"
title: "The agent run record"
state: "decided"
area: "D15"
source:
  issue: "INTENTIUS/chant#3033"
  row: "Record what each agent run cost and which changes it made"
  revision: null
question: "Where does chant keep what each agent run cost and which commits it made, who writes it and through what, what does it hold, and how does a reader total it per work item, decision and principal?"
options:
  - id: "a"
    label: "a run ledger on chant/lifecycle, written through chant workspace runs and joined to commits by Chant-Run"
    how: "Each run is one file, _agent-runs/<id>.jsonl, in the workspace root's ledger on chant/lifecycle, beside the work lease histories. It gets a start line (who it worked for, the agent session, harness, model and provider, the work item, lease and other records, the instruction pinned by hash) and an end line (outcome, turns and tokens, an optional per-model breakdown, the cost with its currency and price source, the transcript pinned by hash, and the commits it made with their patch-ids). Whatever ran the agent writes them with chant workspace runs start and end, or record for both at once; chant allocates the id and prints the Chant-Run trailer the run's commits carry (ws-075). chant workspace runs --json folds the lines, joins commits by the end's list and by the trailer on HEAD's history, finds the decisions through the work item's implements, and totals tokens and cost per work item, decision and principal, listing a run with no cost as unpriced. graph --intent and graph --intent --record link each commit to its run."
    tradeoff: "Every product writes runs the same way, chat turns and decide calls with no work item included, and a reader meters from one document. The figures are as trustworthy as the writer: a box reporting its own cost can report anything, which is studio-020's and #3192's to settle with a proxy figure or a signed statement. A run that never writes its end stays running, and a trailer only joins a commit whose message survived; following a squash is #3035 and joining by patch-id is #3036."
  - id: "b"
    label: "a record kind in the working tree, written through records new"
    how: "Each run is a record file under a runs/ directory with a kind and schema, committed with the work it did."
    tradeoff: "One reader for records and runs, readable at any revision with --at. Every chat turn and decide call adds a file to the next pull request, each goes through write scope and review it doesn't need, and a run is never revised, which ws-068 gives as the reason chant's run outputs stay ledgers."
  - id: "c"
    label: "more fields on the work item's result"
    how: "The factory keeps writing x-factory.result on the item it built, with tokens, cost and commits added."
    tradeoff: "No new store. An item holds one result, so retries and a person's edits between runs are lost, runs with no work item have nowhere to go, and a closed item can't be amended."
  - id: "d"
    label: "the product keeps its runs and chant reads an export"
    how: "The lobby keeps usage.json and hud keeps turn_spend, and each exports runs for chant to read."
    tradeoff: "No chant write command. ws-074 rules it out: the facts would live outside the repo, be lost with a box, and could disagree with the export."
choice:
  option: "a"
  reason: "A run is a fact about something that happened, written once by whatever ran it, which is what chant's ledgers hold (ws-068), and ws-074 puts append-only history on chant/lifecycle with the leases and gates. One file per run keeps concurrent runs from contending for one file, and the start and end lines let a long build be seen while it runs and a crash leave its start behind. The record carries no transcript, only its hash, so nothing a person said to an agent is copied into git. Cost carries its currency and source because studio has not chosen whether the harness, the proxy or the bill prices a run (studio-020, studio-028), and a missing cost is listed, not counted as zero, so a meter never under-reports silently. The fields cover each option studio-019 to studio-023 leaves open: builds and chat turns and decide calls (a unit or none, other records by kind and id), one record per build or per turn, and a writer that is the step that ran the agent or the lobby. The decisions per run come through implements and the records it names; a commit inside a decision's window and made by a run is read through graph --intent --record, which names the run per commit."
rejected:
  - option: "b"
    why: "It puts a never-revised fact through review and write scope and into every pull request's diff, which ws-068 keeps ledgers out of."
  - option: "c"
    why: "One result per item can't hold retries, runs without a work item, or a run after the item closed."
  - option: "d"
    why: "ws-074: a fact kept in a tool's store is lost with the box and can disagree with the repo."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3033, record what each agent run cost and which changes it made"
    url: "https://github.com/INTENTIUS/chant/issues/3033"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/studio#278, the factory records each agent run (studio-019 to studio-023)"
    url: "https://github.com/arugula-salad/studio/issues/278"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/studio#279, per-account metering and spend caps from run records"
    url: "https://github.com/arugula-salad/studio/issues/279"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/hud#729, chat_authors and turn_spend move into the repo"
    url: "https://github.com/arugula-salad/hud/issues/729"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-068, chant's ledgers stay ledgers"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-068-ledgers-stay-ledgers.md"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-074, The repo is the database"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-074-the-repo-is-the-database.md"
    as_of: "2026-10-03T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-03"
reviews: []
constrains:
  - "INTENTIUS/chant#3033"
  - "INTENTIUS/chant#3034"
  - "INTENTIUS/chant#3036"
  - "INTENTIUS/chant#3192"
  - "arugula-salad/studio#278"
  - "arugula-salad/hud#729"
  - "ws-075"
  - "path:packages/core/src/workspace/runs.ts"
---

# The agent run record
