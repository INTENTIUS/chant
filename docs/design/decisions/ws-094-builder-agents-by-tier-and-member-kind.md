---
schema: 1
id: "ws-094"
title: "Builder agents by tier and member kind"
state: "decided"
area: "D17"
source:
  issue: "INTENTIUS/chant#3152"
  row: "workspace: declare builder agents and tiers, replacing studio's agent metadata"
  revision: null
question: "Where does a workspace say which builder agent builds a work item of a given tier, for an app member and for an estate member, so that a slice-tier answer resolves to an agent from the spec alone rather than from studio/role and studio/tier metadata only studio reads?"
options:
  - id: "a"
    label: "a tiers list on the box block's factory, with builderFor in the read contract"
    how: "factory.tiers is a list of { tier, agent, kinds, session }. tier is a word of the work kind's work.tier.tiers (#3147), agent names an agent the factory's builders member declares, kinds limits the entry to members of those kinds, and session names a declared agent session the builder writes as. A tier has at most one entry without kinds and at most one per kind, tiers needs builders, and a session must be declared, or the read fails with declaration-invalid. status --json and graph --json print tiers as declared and builderFor, for each member in builds and each tier, the { agent, session } that builds it: the entry naming the member's kind, else the tier's entry without kinds."
    tradeoff: "One lookup answers a work item's tier for any orchestrator, and infra and app builders share the tier words. The declaration names agents by string, so check can't tell that the builders member really declares them without building it, and the tier words aren't checked against the work kind's vocabulary yet; both are left to the orchestrator that runs the build."
  - id: "b"
    label: "typed role and tier fields on the fountain lexicon's Agent, read by core"
    how: "Agent gains role: build and tier, and core builds the builders member's agents to find the one for a tier."
    tradeoff: "The agent and its tier sit in one place. Core would have to load a lexicon and run the member's code to answer a read, which the read contract never does, and a builder that isn't a fountain Agent, such as a runner's Claude Code or an infra tool, couldn't be declared."
  - id: "c"
    label: "a map box.builders: { <tier>: <agent> }"
    how: "builders becomes a map from tier to agent name."
    tradeoff: "The smallest shape, and it changes the meaning of builders, which 0.102.0 readers already take as a member name. It can't say that an infra builder and an app builder share a tier, which the ops update to #3152 asks for."
  - id: "d"
    label: "agent names in the work kind's tier block"
    how: "work.tier.tiers maps each tier to its builder agent, beside the vocabulary #3147 put there."
    tradeoff: "The tier words and their builders sit together. A record kind would carry the box's runtime configuration, every reader would load the kind module to find a builder, and a workspace with two kinds of builders would need two work kinds."
choice:
  option: "a"
  reason: "The factory block is where ws-077 put what a box builds and which member declares the builders, so the tiers belong beside them and the read contract already prints that block. A list with kinds lets an infra builder and an app builder share a tier, as the ops update asks, and session ties a builder to the write scope of an agent session (ws-067), so an infra builder edits estate members and leaves applies behind gates. builders keeps its 0.102.0 meaning, and builderFor resolves the rule once in chant instead of in each orchestrator."
rejected:
  - option: "b"
    why: "Reading would run lexicon code, and only fountain Agents could be builders."
  - option: "c"
    why: "It breaks builders for 0.102.0 readers and can't say a builder per kind."
  - option: "d"
    why: "It puts a box's configuration in a record kind and every reader would load the module to find it."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3152, declare builder agents and tiers"
    url: "https://github.com/INTENTIUS/chant/issues/3152"
    as_of: "2026-10-03T00:00:00Z"
  - title: "INTENTIUS/chant#3147, the work kind's tiers"
    url: "https://github.com/INTENTIUS/chant/issues/3147"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/studio#287, the factory reads and writes only through chant"
    url: "https://github.com/arugula-salad/studio/issues/287"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-077, factory fields on the box block"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-077-factory-fields-on-the-box-block.md"
    as_of: "2026-10-03T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-03"
reviews: []
constrains:
  - "INTENTIUS/chant#3145"
  - "INTENTIUS/chant#3174"
  - "arugula-salad/studio#287"
  - "ws-067"
  - "ws-077"
---

# Builder agents by tier and member kind
