---
schema: 1
id: "ws-005"
title: "Merge"
state: "decided"
area: "D9"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Merge"
  revision: null
question: "How does `chant workspace upgrade` merge template changes into files the workspace has customised?"
options:
  - id: "a"
    label: "per file"
    how: "A customised `owned` path is three-way merged only if every hunk is clean. Otherwise it stays as it was and becomes one manual step."
    tradeoff: "Nothing is ever half upgraded, and open manual steps fail `check` until done. One conflicting hunk holds back all of the template's changes to that path."
  - id: "b"
    label: "clean hunks"
    how: "Clean hunks are applied, and each conflicting remainder is recorded as a manual step."
    tradeoff: "More of the upgrade lands without hand work. Some sources can sit half upgraded until the step is done."
  - id: "c"
    label: "conflict markers"
    how: "Conflicting hunks are written in place with git-style conflict markers."
    tradeoff: "Developers know the format. Nothing with markers builds until someone resolves them."
  - id: "d"
    label: "none"
    how: "The upgrade never merges, and any customised path becomes a manual step."
    tradeoff: "Simplest to build. Even changes that would merge cleanly need hand work."
choice:
  option: "a"
  reason: "Merging per file keeps each one either on the old version or fully merged. The staged worktree the upgrade checks therefore never holds a half-upgraded source. Clean merges still apply without hand work, and the user's tree changes only when the approved patch is applied."
rejected:
  - option: "b"
    why: "It leaves sources half upgraded, which is harder to review."
  - option: "c"
    why: "Markers would break build and lint in the staged worktree, so the upgrade's own checks could not pass."
  - option: "d"
    why: "Every customised path would need hand work, even when the merge is clean."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D9. Templates and upgrade"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d9-templates-and-upgrade"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2550, migrations and chant workspace upgrade"
    url: "https://github.com/INTENTIUS/chant/issues/2550"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2550"
---

# Merge
