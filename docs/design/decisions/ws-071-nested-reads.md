---
schema: 1
id: "ws-071"
title: "How the outer workspace reads a nested one"
state: "decided"
area: "D2"
source:
  issue: "INTENTIUS/chant#2551"
  row: "A nested workspace is visible read-only; the outer workspace never writes inside it"
  revision: null
question: "ws-007 chose read-only expansion with `outer/inner/id` ids. Through what does the outer workspace read a member of kind `workspace`, where do the nested side's members and links appear in the graph document, and what stops the outer side writing there?"
options:
  - id: "a"
    label: "the nested workspace's own chant workspace graph, folded under the outer member; upgrade refuses patches that reach inside"
    how: "`chant workspace graph` runs `chant workspace graph <nested root>` with the outer read's flags (`--at`, `--env`, `--live`, `--overlay`, `--traffic`, `--no-cache`). That command hands itself to the nested root's chant (ws-021), so the nested side is read under its own toolchain. Its document must carry the graph schema id and a contract this chant reads. Nodes, edges, exports, imports and group keys are prefixed with the outer member's name, each node keeps `member` as the outer member and names the nested member in `nested`, and the outer member entry holds `nested: { name, contract, members, links }`. `chant workspace upgrade` refuses a patch with a path inside a nested workspace. build, lint and audit keep skipping it."
    tradeoff: "The nested side is read exactly as it reads itself, under its own chant and its own read contract, and the outer chant needs no knowledge of its members' kinds or toolchains. It costs one more process per nested workspace, and a nested read that fails marks the outer member failed."
  - id: "b"
    label: "the outer chant reads the nested declaration and plans its members itself"
    how: "Treat each nested member as if declared by the outer workspace, run under the outer root's member-run."
    tradeoff: "One process tree, but the nested workspace's own chant, kinds and pins are bypassed, which is what ws-021 forbids for a root, and the outer chant would need every kind the nested side pins."
  - id: "c"
    label: "list nested members in ls only"
    how: "Show the nested declaration's members in `ls` and leave the graph opaque."
    tradeoff: "Cheap, but a viewer could not see what the nested workspace holds, which is the reason ws-007 chose expansion."
choice:
  option: "a"
  reason: "Reading through the nested workspace's own command is how D8 reads every member (through its own chant graph), one level up, and it keeps the nested side's toolchain, kinds and cache its own. Prefixing with the outer member gives ws-007's `outer/inner/id` without any new id syntax. Links stay the nested side's own, because they name members the outer declaration does not have. The upgrade guard is the one place the outer workspace could write into a nested one's files."
rejected:
  - option: "b"
    why: "It bypasses the nested workspace's own chant and pins."
  - option: "c"
    why: "The graph, which is what a viewer reads, would stay blind to the nested workspace."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2551, adopt-lineage and nesting, audit of 2026-09-30"
    url: "https://github.com/INTENTIUS/chant/issues/2551"
    as_of: "2026-09-30T00:00:00Z"
  - title: "ws-007, Nesting"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-007-nesting.md"
    as_of: "2026-09-30T00:00:00Z"
  - title: "ws-021, Which chant"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-021-which-chant.md"
    as_of: "2026-09-30T00:00:00Z"
  - title: "ws-059, The graph cache"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-059-graph-cache.md"
    as_of: "2026-09-30T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-09-30"
reviews: []
constrains:
  - "INTENTIUS/chant#2551"
  - "path:packages/core/src/workspace/nested-graph.ts"
  - "path:packages/core/src/workspace/nesting.ts"
---

# How the outer workspace reads a nested one

The read is described in [chant workspace graph](https://intentius.io/chant/cli/workspace-graph/#nested-workspaces). The nested read keeps its per-member cache in the user's cache directory (ws-059), so the outer read writes nothing inside the nested workspace.
