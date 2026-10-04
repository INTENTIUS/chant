---
schema: 1
id: "ws-089"
title: "Concurrent writers in one working tree"
state: "decided"
area: "D15"
source:
  issue: "INTENTIUS/chant#3173"
  row: "Concurrent writers in one working tree: record write locking or compare-and-set, and a documented model"
  revision: null
question: "With the repo as the database (ws-074), people through hud, the coding agent, the steward and builders write one box's working tree at once. What keeps two of chant's writes from clobbering each other's record files, what does a writer whose change was made from a stale reading get back, how does a reader see who last wrote a record, and how does a tool make a batch of writes that nobody interleaves with?"
options:
  - id: "a"
    label: "a write lock per working tree held by every chant write, compare-and-set on the record's digest with --expect, a write journal for the last writer, and the lock held across calls for a batch"
    how: "Every chant write to the working tree (records new, amend, review and close, points ask and answer, box listing set, and work evidence through amend) takes the lock directory chant-write.lock in the working tree's git directory with mkdir, from its first read to its last write, and replaces a record file through a temporary file and a rename. owner.json says who holds it; a holder whose process has gone or whose expiresAt has passed is broken by the next writer, and a writer that waits longer than CHANT_WRITE_LOCK_WAIT_MS (15s) is refused with write-lock-timeout naming the holder. amend, review and close take --expect <digest>, the read contract's digest the caller read the record at, and are refused with record-conflict when the record has another, with conflict {id, path, expected, digest, lastWrite} in the document. Every write result carries the record's digest after the write. A journal, chant-writes.json beside the lock, notes the last chant write of each record file by the file's SHA-256, and records --json prints it as lastWrite while the file holds that text. chant workspace lock acquire --holder <name> [--ttl] takes the lock for a batch and prints a token; each chant write run with CHANT_WRITE_LOCK=<token> goes ahead without waiting, and lock release gives it back."
    tradeoff: "Two writes never build on one reading of a file, ids are never handed out twice, and a person's change made from an old view is refused with what changed and who changed it instead of overwriting it. A UI that wants that protection has to pass --expect, and a blind write still serialises and replaces the fields it sets. Writers wait on each other for the length of one write, or of a batch, up to the wait limit. The journal is a cache in the git directory: lost, lastWrite reads null and nothing else changes."
  - id: "b"
    label: "compare-and-set on the record only, with no lock"
    how: "Each write reads the record, builds its file, and just before writing checks that the file still has the digest it read, refusing otherwise."
    tradeoff: "No lock to wait on or break. The check and the write are two steps, so two writers can both pass the check and the second still overwrites the first; two records new still allocate one id; and a write without an expectation has nothing to compare."
  - id: "c"
    label: "a lock only, with no compare-and-set"
    how: "Every write holds the lock, so writes serialise, and each applies its fields to the record as it is then."
    tradeoff: "No write is lost to a race, but a person who edited a record from a view an agent has since changed silently replaces the agent's change, which the issue rules out."
  - id: "d"
    label: "merge a stale write into the current record automatically"
    how: "The caller passes the digest it read; chant keeps the text at each digest and three-way merges the caller's change into the current record, refusing only on overlapping fields."
    tradeoff: "Fewer refusals. chant has to keep every text a caller may have read, a merge of two edits to one decision's options or reason can read well and mean nothing anyone chose, and the person whose change was merged never sees what it was merged with."
  - id: "e"
    label: "one working tree per writer, joined by git"
    how: "Each principal writes in its own worktree or branch, and their changes meet in git merges."
    tradeoff: "No contention in one tree. A box's people and its agent share one checkout by design, a record two of them change becomes a git conflict in a front matter file, and the box's work in progress (ws-085) splits across branches."
choice:
  option: "a"
  reason: "The issue asks that two records amend calls on one record never silently overwrite, that the second fail with a reason and the current digest, that the read contract report a record's last writer and digest, and that the model be written down. Only the lock and the compare-and-set together give that: the lock makes the read-check-write of one command atomic against every other chant write, which compare-and-set alone can't (option b), and the expectation turns a change made from a stale view into a refusal the caller can show, which a lock alone can't (option c). The digest compared is the one records --json already prints and a verdict already names, so a caller has it without a new read, and since reviews and seals stay out of it, a verdict landing between a read and an amendment is kept rather than reported as a conflict. The lock lives in the git directory, keyed by the working tree, so linked worktrees and builders in their own worktrees never wait on each other, and it is a directory made with mkdir so any tool can take it without chant's code. Ledger writes on chant/lifecycle were already compare-and-set on the branch and stay as they are. hud#819 needs a batch nobody interleaves with before it publishes per writer; holding the same lock across chant calls with a token gives it one without a second mechanism, and a tool's own files written inside the batch are covered by taking the same lock. Kinds should still give each principal its own record or entry where they can (one verdict per reviewer, one answer per question), as #3148's kinds do, so most concurrent writes never touch the same field."
rejected:
  - option: "b"
    why: "The check and the write are two steps, so a race between them still loses a write, and id allocation still collides."
  - option: "c"
    why: "A change made from a stale view overwrites another principal's change without anyone seeing it, which #3173 rules out."
  - option: "d"
    why: "chant would keep every text a caller may have read and produce merges nobody chose; a conflict a person sees is the safer outcome for a decision."
  - option: "e"
    why: "A box's people and agent share one checkout, and splitting it moves the conflict into git merges of front matter."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3173, concurrent writers in one working tree"
    url: "https://github.com/INTENTIUS/chant/issues/3173"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/hud#819, an atomic per-writer publish batch once concurrent writers land in chant"
    url: "https://github.com/arugula-salad/hud/issues/819"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/hud#371, a second agent on the box is announced"
    url: "https://github.com/arugula-salad/hud/issues/371"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-074, the repo is the database"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-074-the-repo-is-the-database.md"
    as_of: "2026-10-03T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-03"
reviews: []
constrains:
  - "INTENTIUS/chant#3173"
  - "INTENTIUS/chant#3159"
  - "INTENTIUS/chant#3148"
  - "arugula-salad/hud#819"
  - "arugula-salad/studio#287"
  - "ws-074"
  - "path:packages/core/src/workspace/write-lock.ts"
---

# Concurrent writers in one working tree

The model chant's writers and the tools built on them (hud, studio's factory, the steward) follow in one working tree. The reference is the read contract's [Concurrent writers](https://intentius.io/chant/reference/workspace-read-contract/#concurrent-writers).

## What is serialised

Every chant write to the working tree: `records new`, `amend`, `review` and `close`, `points ask` and `answer`, `box listing set`, and `work evidence` through `amend`. Each holds `chant-write.lock` in the working tree's git directory from its first read to its last write, so it reads what the write before it left. A write waits up to `CHANT_WRITE_LOCK_WAIT_MS` (15 seconds) and is refused with `write-lock-timeout`, naming the holder. A lock whose process has gone, or whose `expiresAt` has passed, is broken. A dry run takes no lock. Writes on `chant/lifecycle` (leases, runs, a steward's answers) were already compare-and-set on the branch.

## What is merged

A write without `--expect` applies its fields to the record as it is when it runs. Two amendments of different fields both land, a verdict is appended to the reviews as they are, and the later of two amendments of one field wins. Reviews and seals are outside the digest, so a verdict between a read and an amendment is kept.

## What is a conflict

A write with `--expect <digest>` whose record has another digest. `amend`, `review` and `close` refuse it with `record-conflict` and `conflict: {id, path, expected, digest, lastWrite}`. The caller re-reads, shows the person, and writes again with `--expect` set to `digest`. Of several writes from one digest exactly one is written. A UI that writes what a person did with a record they were shown passes `--expect`.

## A batch

`chant workspace lock acquire --holder <name> [--ttl <duration>]` takes the lock for up to 10 minutes and prints a token. Each chant write run with `CHANT_WRITE_LOCK=<token>` goes ahead without waiting, other writers wait, and `lock release --token <token>` ends the batch. A tool writing its own files in the batch, such as hud's app files for a per-writer publish (hud#819), takes the lock first. A batch whose lock expired gets `write-lock-not-held` on its next write and starts again.

## The last writer

`records --json` prints each record's `lastWrite`, `{verb, by, agent, at}`, from `chant-writes.json` in the git directory, while the file holds the text that write left. It is a cache, never a fact (ws-074).
