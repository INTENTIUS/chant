---
schema: 1
id: "ws-057"
title: "How the factory's builds on Fountain divide between the spec and the thin layer"
state: "decided"
area: "D17"
source:
  issue: "INTENTIUS/chant#2714"
  row: "The factory's builds on Fountain"
  revision: null
question: "When chud retires, how does the factory's build path on Fountain (a builder agent per tier, a dispatcher that claims ready work and builds it) divide between the workspace specification, chant's fountain lexicon and the thin layer?"
options:
  - id: "a"
    label: "declarations stay as they are in the workspace; the runner moves to the studio kit on fountainRun and ws-055's ledgers"
    how: "The builders are already declared with chant's fountain lexicon in the generated repo (`delivery/agents/team.ts`): an Environment (`bench`, limited networking, a setup script), a Vault for the git token (a reference, not a value), an Agent per builder tier, and the dispatcher as a Teammate with a Schedule that posts `chant run dispatch`. That is specification and stays in the workspace unchanged. The builder tier a contract gets is a decision point (#2723, the `slice-tier` point chud already has). The runner is runtime and moves to the studio kit: take a work item's lease (ws-055), run the builder through `fountainRun` (ephemeral agents; #2718 makes a persistent one safe too), fetch the pushed work, apply it, run the guard and the check, then record the work item and its evidence. The evidence carries a `source` block naming harness `fountain`, the model and the conversation (#2708). Builders stay ephemeral agents, a sandbox per build. `Box` (#2705) is the app's machine, and `Steward` is the environment's operator; neither is a builder."
    tradeoff: "Nothing new is needed in chant beyond what is decided or merged (ws-055, #2708, #2718, #2723): the spec already declares the agents. The kit gains the runner, the one part that is runtime. The runner's guard and check logic must be carried over from chud's dispatcher intact, and it is the largest single move in the retirement."
  - id: "b"
    label: "builders as persistent Boxes"
    how: "Each builder tier is a `Box`, a persistent machine that keeps its checkout and tool cache across builds."
    tradeoff: "Builds would be faster on a warm machine. But builds of different contracts would share a machine and its state, which breaks the isolation a build relies on, and every tier pays for an idle machine. Box's purpose is serving an app."
  - id: "c"
    label: "the dispatcher as a Steward"
    how: "The dispatcher Teammate becomes a `Steward` (an agent running `chant acp` on a persistent sandbox), which runs `chant run dispatch` as one of its Ops. The builders stay ephemeral agents."
    tradeoff: "It uses the existing composite for 'the machine an environment is operated from', and the dispatch loop gets a persistent home on Fountain. It is compatible with option a and can be added to it; it is listed separately because it changes what the dispatcher is, from a scheduled prompt to an operator."
choice:
  option: "a"
  reason: "The builders are already specification, declared with chant's fountain lexicon, so the runner moves to the studio kit on ws-055's ledgers, fountainRun and decision points. Option c is adopted with it: the dispatcher becomes a Steward, because every box's operational work runs through chant's Steward (lex00, 2026-09-25; INTENTIUS/chant#2731, arugula-salad/studio#46)."
rejected:
  - option: "b"
    why: "Builds of different contracts would share a machine and its state, and each tier would pay for an idle machine; Box is for serving an app."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2714, research: chud's factory builds on Fountain, through chant's fountain lexicon"
    url: "https://github.com/INTENTIUS/chant/issues/2714"
    as_of: "2026-09-25T22:10:00Z"
  - title: "INTENTIUS/chant#2715, epic: retire chud"
    url: "https://github.com/INTENTIUS/chant/issues/2715"
    as_of: "2026-09-25T22:10:00Z"
  - title: "The generated repo's builders, declared with chant's fountain lexicon (template/delivery/agents/team.ts at jhgaylor/chud 43afcf1)"
    url: "https://github.com/jhgaylor/chud/blob/43afcf108d40a8b7b4c14544b8991451a5a56f2f/template/delivery/agents/team.ts"
    as_of: "2026-09-25T22:10:00Z"
  - title: "chud's dispatcher: claim with a lease, run the builder locally or with fountainRun, apply the pushed work, guard, check, record (packages/runtime/src/dispatch.mjs at 43afcf1)"
    url: "https://github.com/jhgaylor/chud/blob/43afcf108d40a8b7b4c14544b8991451a5a56f2f/packages/runtime/src/dispatch.mjs"
    as_of: "2026-09-25T22:10:00Z"
  - title: "ws-055, decided option a: leases and plans on chant/lifecycle (INTENTIUS/chant#2721)"
    url: "https://github.com/INTENTIUS/chant/pull/2721"
    as_of: "2026-09-25T22:10:00Z"
  - title: "The fountain lexicon's Steward composite"
    path: "lexicons/fountain/src/composites/steward.ts"
    sha256: "6dabced21a71d960883afb5b2c6eac6b8cd11b17158099cec9f88b4528fb5281"
  - title: "The fountain lexicon's Box composite (#2705)"
    path: "lexicons/fountain/src/composites/box.ts"
    sha256: "0fa609c8b44dbb5cfc993e2dbc63345f2bf151674d974f278bcd46cef4f77e58"
  - title: "fountainRun, which returns when a persistent agent's turn ends (#2718)"
    path: "lexicons/fountain/src/op/activities/fountain-run.ts"
    sha256: "c71ed870b7e3593aff4ac8cee0ac40a80afe57ec4874b1a51e4693346de9de1e"
decided_by: "lex00"
decided_on: "2026-09-25"
reviews: []
constrains:
  - "INTENTIUS/chant#2714"
  - "path:lexicons/fountain"
x-recommendation:
  option: "a"
  reason: "The builders are already specification, declared with chant's fountain lexicon in the workspace, so the question is only where the runner goes, and it is runtime: the studio kit. Everything it needs from chant is decided or merged (ws-055's ledgers, the source block, fountainRun's persistent fix, decision points). Option c can be added to a later: it is a choice about the dispatcher's home, not about the split."
---

## Context

The research question was whether the factory's Fountain builder should become chant's fountain lexicon. It already is one. chud's generated repo declares its builders, its git Vault and its dispatcher Teammate with `@intentius/chant-lexicon-fountain`, and the dispatcher's Fountain runner calls the lexicon's `fountainRun`. What remains chud-specific is the runner around that call: the lease, applying the pushed work, the guard, the check and the record.

## Recommendation

Option a. Keep the declarations as specification, and move the runner to the studio kit on the pieces chant has now. Option c is a separate, compatible question about the dispatcher's home.

## Implementation issues, if option a is chosen

1. The factory runner in the studio kit: lease, `fountainRun`, apply, guard, check and record, with the guard and check carried over from chud's dispatcher.
2. The builder tier as a decision point (#2723).
3. Build evidence with a `source` block naming Fountain, the model and the conversation (#2708).
4. A studio smoke claim: a factory turn on the fountain-k3d preset that writes its lease and plan through chant.
