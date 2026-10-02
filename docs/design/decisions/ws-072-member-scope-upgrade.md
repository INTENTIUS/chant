---
schema: 1
id: "ws-072"
title: "A member made from a template upgrades from its own lock, under its own gate"
state: "decided"
area: "D9"
source:
  issue: "INTENTIUS/chant#2550"
  row: "Templates and upgrade"
  revision: null
question: "How does chant workspace upgrade reach a workspace member that was made from a template, and what keeps two members' upgrades apart?"
options:
  - id: "a"
    label: "the member's own lock, upgraded from the member's directory"
    how: "chant init --from <template> <member dir> already writes the lock inside that directory. From the workspace root, upgrade <member> finds the member in chant.workspace.json by name or directory and runs the upgrade with the member's directory as the project root, scope \".\". The gate and the proposal branch use the member's name."
    tradeoff: "No new lock format and the whole existing upgrade applies unchanged: the patch, build, lint and check all run inside the member. A scope the root's lock holds under the member's directory still wins, so both layouts work."
  - id: "b"
    label: "one lock at the workspace root with a scope per member"
    how: "init --from inside a workspace writes a scope keyed by the member's directory into the root lock."
    tradeoff: "One file to read. It changes where init writes its lock, which every reader of a member's lineage then depends on, and a member that is later exported takes its lineage out of a shared file."
  - id: "c"
    label: "no member scopes"
    how: "Members are upgraded by running the command inside their directory."
    tradeoff: "Nothing to build. The gate name \".\" collides across members on the shared ledger, and an upgrade run from the root cannot reach them."
choice:
  option: "a"
  reason: "The lock already sits with the files it describes, so a member exported or vendored elsewhere keeps its lineage. Resolving from the root only needs the declaration, and naming the gate for the member fixes the collision that running in each directory would cause. The upgrade checks that its patch touches only the scope and the lock, which is the write boundary D9 promises for a member."
rejected:
  - option: "b"
    why: "It moves where init writes and ties a member's lineage to the workspace's file."
  - option: "c"
    why: "Two members would share the gate name \".\" on the ledger."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2550, audit of 2026-09-30: member scopes not met"
    url: "https://github.com/INTENTIUS/chant/issues/2550"
    as_of: "2026-09-30T00:00:00Z"
  - title: "INTENTIUS/chant#2524, D9 and D13"
    url: "https://github.com/INTENTIUS/chant/issues/2524"
    as_of: "2026-09-30T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-09-30"
reviews: []
constrains:
  - "INTENTIUS/chant#2550"
  - "path:packages/core/src/workspace/lineage-upgrade.ts"
---

# A member made from a template upgrades from its own lock, under its own gate

`chant workspace upgrade <member>` is described in [workspace upgrade, Member scopes](https://intentius.io/chant/cli/workspace-upgrade/#member-scopes). Scopes made by `chant init --template` stay refused: they have no versioned source and no offline merge base.
