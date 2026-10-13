---
schema: 1
id: "ws-067"
title: "Write scope and agent sessions"
state: "decided"
area: "D5"
source:
  issue: "INTENTIUS/chant#2548"
  row: "Write scope per member and agent sessions"
  revision: null
question: "#2524 D5 gives each member and record kind a write scope per principal class, and D20 binds an agent session to one member that reloads from the declaration and the spec query. Where is the scope declared, how is a writer's class and session found, where is it enforced, and what does a session reload from?"
options:
  - id: "a"
    label: "writeScope and agents in the declaration, read at base; classes from role grants; the session named by CHANT_AGENT or a Chant-Agent trailer"
    how: "chant.workspace.json gains writeScope, an entry per restricted principal class (human, agent, runner, service) with the members it may write and, per record kind name, the verbs new, amend, review and close; and agents, sessions each bound to one member, optionally listing principals that write only as that session. An agent's members are always its session's one member; the workspace's own record kinds are in every session's reach. A principal's class is the first of the agent, runner and service roles it holds in the trust policy at base, else human, read through one function. records new, amend, review and close and the MCP record tools refuse a write outside scope with write-scope-member, write-scope-kind or agent-unknown, with the session named by CHANT_AGENT. check --changes judges each commit in the range by its Chant-Agent trailer, its attested principal or its author, against the declaration and policy at the range's base. chant workspace agent <name> prints the session's member, its scope and the spec block records --current --json prints."
    tradeoff: "One place holds the policy, and it is read at base, so a change can't widen its own scope, and an edit to the declaration by a member-scoped writer is itself out of scope. A session name is unverified, but naming one only narrows what a writer may do. On a developer machine it detects; it enforces only where the principal is attested, as ws-002 says for everything else."
  - id: "b"
    label: "each record kind file declares its own write scope per principal class"
    how: "D4 lists a write scope per principal class among the things a record kind declares. Each kind file would carry a writeScope block, and a member's write scope would be a separate declaration field."
    tradeoff: "The kind travels with its scope. A kind file is plugin data loaded from the working tree, not read at base, so a change could edit its own kind file to widen its scope, and the same kind copied into two workspaces could not be scoped differently."
  - id: "c"
    label: "write scope in .chant/trust.json beside the signers and role grants"
    how: "trust.json, already read at base, gains the scope rules; sessions stay out of chant."
    tradeoff: "Policy sits with policy. The rules name members and record kinds, which only the declaration knows, so trust.json would repeat names it can't check, and #2534 already moves role grants toward the declaration."
choice:
  option: "a"
  reason: "The scope names members and record kinds, so it belongs where they are declared, and the declaration can be read at base the way the trust policy is (threat model). Kind files are loaded from the working tree, which would let a change widen its own scope (option b). Reading classes from role grants keeps one source for who an agent is, the agent role quorums already use (#2671). Binding a session by an environment variable and a trailer needs no state outside the repository, and since a session only narrows scope, an unverified name is safe. The reload command prints only what the declaration and the spec query hold, so an agent resumes from the repository alone (D20)."
rejected:
  - option: "b"
    why: "A kind file is read from the working tree, so a change could widen its own scope, and copies of one kind couldn't be scoped per workspace. A kind may still ship a default later that the declaration narrows."
  - option: "c"
    why: "The rules name members and kinds that only the declaration knows, and role grants are already moving into the declaration."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2548, write scope per member and agent sessions (phase 3c), audit of 2026-09-30"
    url: "https://github.com/INTENTIUS/chant/issues/2548"
    as_of: "2026-09-30T00:00:00Z"
  - title: "INTENTIUS/chant#2524, D5. Provenance and D20. The spec and agents"
    url: "https://github.com/INTENTIUS/chant/issues/2524"
    as_of: "2026-09-30T00:00:00Z"
  - title: "ws-048, Agents"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-048-agents.md"
    as_of: "2026-09-30T00:00:00Z"
  - title: "ws-002, Local promise"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-002-local-promise.md"
    as_of: "2026-09-30T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-09-30"
reviews: []
constrains:
  - "INTENTIUS/chant#2548"
  - "path:packages/core/src/workspace/write-scope.ts"
  - "path:packages/core/src/workspace/agent-cli.ts"
---

# Write scope and agent sessions

The declaration's `writeScope` and `agents` are described in [Workspace Declaration](https://intentius.io/chant/reference/workspace-declaration/#write-scope-and-agent-sessions), and the reload in [chant workspace agent](https://intentius.io/chant/cli/workspace-agent/).
