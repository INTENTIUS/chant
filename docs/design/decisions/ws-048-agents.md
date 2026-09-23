---
schema: 1
id: "ws-048"
title: "Agents"
state: "decided"
area: "D20"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Agents (v8)"
  revision: "v8"
question: "How are agent sessions scoped, and how does one resume?"
options:
  - id: "a"
    label: "member scope plus a reload query"
    how: "A session is bound to one member, with that member's write scope. It resumes from the declaration plus the spec query, with no other state."
    tradeoff: "No state store is needed, and writes can be checked against one member. Work across members needs a session per member."
  - id: "b"
    label: "record kind only"
    how: "A record kind holds agent declarations and data, and nothing else is defined."
    tradeoff: "Fits the records model. It gives no write scope and no rule for how a session resumes."
  - id: "c"
    label: "plugins"
    how: "Plugins supply agent support, with nothing in core."
    tradeoff: "Keeps core small. Each plugin would scope and reload sessions its own way, and core checks couldn't rely on any of them."
choice:
  option: "a"
  reason: "An agent running as the user can tamper locally (threat model), so its writes must be checkable at the boundary. `agent` is a core principal class, and write scope is per member and record kind (D5), so binding a session to one member gives `check` a scope to enforce (#2548). Reloading from the declaration and the spec query needs only the repo. Derived data can still be a record kind or a declared cache (D4). The row is new in v8."
rejected:
  - option: "b"
    why: "A record kind holds data but can't bound what a session writes or say how it resumes."
  - option: "c"
    why: "Write scope is a core check, so the scope a session runs under can't come from each plugin."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D20. The spec and agents"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d20-the-spec-and-agents"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Agents (v8)"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Threat model"
    url: "https://github.com/INTENTIUS/chant/issues/2524#threat-model"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, D5. Provenance"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d5-provenance"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2548, write scope per member and agent sessions (phase 3c)"
    url: "https://github.com/INTENTIUS/chant/issues/2548"
    as_of: null
  - title: "INTENTIUS/chant#2546, records, seals and the spec query (phase 3a)"
    url: "https://github.com/INTENTIUS/chant/issues/2546"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2548"
  - "INTENTIUS/chant#2546"
---

# Agents
