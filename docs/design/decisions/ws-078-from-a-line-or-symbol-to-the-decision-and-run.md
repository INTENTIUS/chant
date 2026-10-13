---
schema: 1
id: "ws-078"
title: "From a line or symbol to the decision and the agent run behind it"
state: "decided"
area: "D15"
source:
  issue: "INTENTIUS/chant#3034"
  row: "From a line or symbol to the decision and the agent run behind it"
  revision: null
question: "How does a reader go from a line range or a symbol to the decisions governing it and the agent run that wrote its current lines, ranked, with a plain answer when nothing explains it?"
options:
  - id: "a"
    label: "symbol regions in graph --intent, and a why answer in the same document, from git blame and the run ledger"
    how: "graph --intent takes path#symbol. Core resolves the symbol to its current lines in the tree read, with a resolver chosen by file extension; the TypeScript and JavaScript resolver parses with the TypeScript compiler core already depends on. The lines are then followed with git log -L like any line range. The document gains why: git blame over the region's current lines, each span with the commit that last wrote it and the runs made-by joins to that commit; a run's end may record per-commit hunks, which pick the run that wrote a line when several share one commit. A recorded run's work item and records are carried by its commits, as a Chant-Lease item and a Chant-Record are. why ranks the decisions (carried, then path, contract, issue, member, then related; current before superseded), lists the runs by lines written with their work item, and says explained: false with closed gap codes when nothing accounts for the region."
    tradeoff: "One read and one schema for hud: the graph it already draws and the answer it shows first. The answer is only as good as blame: a moved or reformatted line is blamed on the commit that moved it, and a squash merge or a lost trailer leaves the line with no run until #3035 and #3036 land. Only TypeScript and JavaScript resolve symbols."
  - id: "b"
    label: "a separate chant workspace why command"
    how: "A new command and schema that prints only the answer: blame, runs and ranked decisions."
    tradeoff: "A smaller document, and a second contract, a second MCP tool and a second reader in hud for the same walk. The ranking would need the decisions, windows and joins graph --intent already computes, so it would run the walk anyway."
  - id: "c"
    label: "git log -L :funcname: for symbols, and the commit list as the answer"
    how: "Hand the symbol to git's own function-name matching, and leave the reader to pick the commit that matters from the history."
    tradeoff: "No parser in chant. git's funcname patterns are regexes per diff driver, miss methods and arrow functions bound to constants, and need a gitattributes setup the repository may not have; and the history lists every commit that ever touched the lines, not the one that wrote them now, so the reader still can't say which run made the code in front of the person."
choice:
  option: "a"
  reason: "hud#700 asks one question from a gutter or a command: why is this code like this. The answer needs the same decisions, windows and trailer joins graph --intent already gathers, so it belongs in that document, added within contract 1 like run nodes and trailer joins were. Blame, not the region's history, says who made the lines in front of the person, and the run ledger already joins commits to runs (ws-076), so the run that wrote a line comes from what exists, narrowed by hunks only when a writer records them. Resolving symbols with the TypeScript compiler gives exact ranges for the languages the workspace's own members are written in; other languages keep line ranges and get a clear refusal. explained: false is a closed answer a reader can act on: hud offers to record a decision there."
rejected:
  - option: "b"
    why: "It would repeat the walk behind a second contract for one consumer."
  - option: "c"
    why: "git's funcname matching is not reliable for TypeScript, and a history is not an answer to who wrote these lines now."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3034, from a line or symbol to the decision and the agent run behind it"
    url: "https://github.com/INTENTIUS/chant/issues/3034"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/hud#700, why is it like this, from a line or symbol"
    url: "https://github.com/arugula-salad/hud/issues/700"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-075, chant's commit trailers"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-075-commit-trailers.md"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-076, the agent run record"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-076-the-agent-run-record.md"
    as_of: "2026-10-03T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-03"
reviews: []
constrains:
  - "INTENTIUS/chant#3034"
  - "INTENTIUS/chant#3035"
  - "INTENTIUS/chant#3036"
  - "arugula-salad/hud#700"
  - "ws-076"
  - "path:packages/core/src/workspace/intent.ts"
  - "path:packages/core/src/workspace/symbols.ts"
---

# From a line or symbol to the decision and the agent run behind it

`graph --intent path#symbol` resolves a TypeScript or JavaScript declaration to its current lines and walks them as a line range. Every read of a file region also answers `why`: `git blame` over the current lines, the agent run behind each span (narrowed by the hunks a run recorded, when several runs share a commit), the decisions most relevant first, the runs by lines written with their work item, and `explained: false` with closed gap codes when nothing accounts for the region. A recorded run's work item and records are carried by its commits as chant's trailers are. Squash merges (#3035) and patch-id joins (#3036) are left to their issues; run records already keep each commit's patch-id for the latter.
