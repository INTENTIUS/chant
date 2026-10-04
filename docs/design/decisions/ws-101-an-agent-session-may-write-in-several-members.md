---
schema: 1
id: "ws-101"
title: "An agent session may write in several members"
state: "decided"
area: "D5"
source:
  issue: "INTENTIUS/chant#3505"
  row: "an agent session may declare more than one member (revises ws-067's binding)"
  revision: null
question: "ws-067 binds each agent session to one member, so a session writes that member's files and the records of kinds that member or the workspace declares. A factory's build writes the app and also its evidence record in the design member (arugula-salad/studio#402), so a factory session bound to the app fails every build with write-scope-member. How does a session that legitimately writes in more than one member declare that?"
options:
  - id: "a"
    label: "an agent entry names its members with members, a list, in place of member; writeScope judges the union"
    how: "An entry in agents takes exactly one of member, a single member as before, and members, a non-empty list of declared members. The session writes the files of any member it names and the records of kinds any of them or the workspace declares, and writeScope.agent's records and protected rules apply to that union. The parsed declaration carries members on every session and keeps member as the first. chant workspace agent --json prints agent.members and every name under scope.members, with the workspace's kinds and then each member's kinds in reach, and keeps agent.member as the first for older readers. export keeps a session with the members that travel. A declaration that uses members sets minReader to 0.105.0."
    tradeoff: "The binding says where a session writes, so no member exists only to hold agents, and a one-member session is unchanged. Readers of chant workspace agent that read only agent.member see the first member, and a declaration that uses members needs chant 0.105.0 to read it."
  - id: "b"
    label: "keep one member per session, and have a box declare a root member its factory and chat agents bind to"
    how: "The template gains a member whose directory is the box root, holding app and design, and the factory and planter-chat sessions bind to it. writeScope.agent.protected keeps them off the declaration, the box's Ops and anything else at the root they must not touch."
    tradeoff: "No chant change. The session's reach is the whole box less what protected names, so the scope is only as narrow as the protected list is complete, and every box template carries an extra member."
  - id: "c"
    label: "one session per member, with an orchestrator switching sessions within a build"
    how: "The factory declares factory-app and factory-design and names whichever session matches each write: CHANT_AGENT for the record write, and a Chant-Agent trailer on separate commits for the app's files and the evidence record."
    tradeoff: "No chant change, and each write still names one member. An orchestrator has to split a build's writes by member, and the build and its evidence land as separate writers' commits."
choice:
  option: "a"
  reason: "The binding exists so a session writes only where it is meant to, and naming the members it is meant to write says that directly. A root member (option b) gives the session every path under the box and then takes paths back one protected entry at a time, so anything the list forgets is in scope, which inverts what ws-067 wanted from a binding. Splitting a build into one session per member (option c) makes a single build two writers and two commits only to satisfy the rule, and the evidence record is part of the build it describes. ws-067 chose one member when no workspace had an agent that needed more; this revises that part of ws-067, and only that part: where the scope is declared (the declaration, read at base), how a writer's class and session are found (role grants, CHANT_AGENT and the Chant-Agent trailer), where it is enforced (the record writes, the MCP tools and check --changes) and what a session reloads from all stand. A session still only narrows: naming several members gives no more than a writer of its class would have without the session, and writeScope.agent still sets the record kinds and protected paths for all of it. A single member keeps working unchanged, so no declaration has to change."
rejected:
  - option: "b"
    why: "It binds the session to everything under the root and relies on protected entries to take paths back, so the scope is as wide as whatever the list forgets, and every box template carries a member that exists only to bind agents to."
  - option: "c"
    why: "One build becomes two writers and at least two commits so that each write names a session bound to its member, which complicates every orchestrator and splits a build's evidence from the build."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3505, an agent session may declare more than one member"
    url: "https://github.com/INTENTIUS/chant/issues/3505"
    as_of: "2026-10-04T00:00:00Z"
  - title: "arugula-salad/studio#402, the template can't declare its agents until an agent can write in more than one member"
    url: "https://github.com/arugula-salad/studio/issues/402"
    as_of: "2026-10-04T00:00:00Z"
  - title: "ws-067, write scope and agent sessions"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-067-write-scope-and-agent-sessions.md"
    as_of: "2026-10-04T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-04"
reviews: []
constrains:
  - "INTENTIUS/chant#3505"
  - "arugula-salad/studio#402"
  - "ws-067"
  - "path:packages/core/src/workspace/write-scope.ts"
  - "path:packages/core/src/workspace/agent-cli.ts"
---

# An agent session may write in several members
