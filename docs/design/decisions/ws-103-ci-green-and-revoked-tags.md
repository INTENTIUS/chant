---
schema: 1
id: "ws-103"
title: "CI green and revoked tags"
state: "decided"
area: "D19"
source:
  issue: "INTENTIUS/chant#3573"
  row: "tag each commit that passes its required phases, and revoke the tag if it later fails"
  revision: null
question: "How does a workspace record which commits on its branch passed CI, so a person or a tool can find the newest one from git alone, without asking the forge?"
options:
  - id: "a"
    label: "an immutable green tag per passing commit, and a revoked tag when it later fails"
    how: "The declaration's ci.green names a branch, a window and phases, each a list of check-run name patterns or { runs, skipped }, and the phases a commit must pass. A phase passes when every check run its patterns match finished with success, judged by each run's latest attempt; a skipped run counts only under skipped: pass, and a run in progress leaves the commit undecided. chant ci tick walks the branch's first-parent commits within the window and makes ci/green/<sha>, annotated with the time and each phase's runs, when every required phase passed, and ci/revoked/<sha>, annotated with the phase, the run and the time, when a green commit later fails one. chant never moves or deletes either tag. A generated root CI file runs the tick on workflow_run: completed for the workflows holding required runs and on a 15-minute cron, in one concurrency group that never cancels. chant ci last-green prints the newest commit with a green tag and no revoked tag."
    tradeoff: "The record is git's own and travels with every clone, and each tag says why it was made. Revocation is a second tag rather than an edit, so a revoked commit stays revoked until a person deletes that tag by hand. The tags are unprotected until a forge ruleset limits who may create them."
  - id: "b"
    label: "one moving latest-green tag"
    how: "The tick force-moves a single tag, such as ci/latest-green, to the newest passing commit."
    tradeoff: "One ref to read. Moving it rewrites history a reader may have fetched, and it keeps no record of which other commits passed or which were revoked."
  - id: "c"
    label: "a ledger on chant/lifecycle"
    how: "The tick appends a line per verdict to a ledger file on the chant/lifecycle branch."
    tradeoff: "Fits chant's other ledgers. A reader needs the ledger branch and chant's ledger format to answer a question a tag answers with git alone."
  - id: "d"
    label: "ask the forge each time"
    how: "chant ci last-green reads the check runs of recent commits from the forge on every call, as the release preflight does today."
    tradeoff: "Nothing to keep. Every reader needs a token and the network, and the answer is gone once the forge expires the runs."
choice:
  option: "a"
  reason: "The first user, arugula-salad/illogical, wants a known-good commit to freeze and release from, read from git without the forge. Annotated tags made once give that, and each one keeps the runs that justified it, which ws-074's repo-as-database asks of a durable fact. Revoking with a second tag keeps both facts and makes a revoked commit's return a deliberate act. The check-run lists stand in for chant's phases until chant generates the pipelines (ws-041), and require does not change then. GitHub's check runs are read behind a small forge interface that Forgejo statuses and GitLab jobs can implement later; the tags themselves need no forge API."
rejected:
  - option: "b"
    why: "A moving tag rewrites a ref readers fetch and loses the record of every other verdict; the annotated tags are the record."
  - option: "c"
    why: "A ledger duplicates what the tags already hold and makes a reader depend on the ledger branch."
  - option: "d"
    why: "It needs the forge and a token on every read, which is what the tags are for."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3573, CI: tag each commit that passes its required phases, and revoke the tag if it later fails"
    url: "https://github.com/INTENTIUS/chant/issues/3573"
    as_of: "2026-10-06T20:16:43Z"
  - title: "ws-042, root CI files"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-042-root-ci-files.md"
    as_of: "2026-10-06T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-06"
reviews: []
constrains:
  - "INTENTIUS/chant#3573"
  - "ws-042"
  - "path:packages/core/src/workspace/ci-green.ts"
  - "path:packages/core/src/workspace/ci-green-workflow.ts"
  - "path:packages/core/src/workspace/ci-last-green.schema.json"
---

# CI green and revoked tags
