---
schema: 1
id: "ws-002"
title: "Local promise"
state: "decided"
area: "threat model"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Local promise"
  revision: null
question: "What can chant promise about records on a single developer machine with no enforcement boundary?"
options:
  - id: "a"
    label: "detection only"
    how: "`workspace check` reports each record's provenance level and key type on the local machine. Enforcement happens at a boundary the agent can't write to, such as CI on a protected branch."
    tradeoff: "Developers need nothing new, and the docs state plainly what a same-user agent can do. Locally, tampering is reported but can't be stopped."
  - id: "b"
    label: "hardware key per signature"
    how: "Every signature needs a hardware key with a human touch, so a process running as the user can't sign alone."
    tradeoff: "Laptop signatures become trustworthy only if a sandbox also keeps the agent away from signing-agent sockets. Each one needs a person present."
  - id: "c"
    label: "separate principal"
    how: "Signing runs as a separate OS user or on a separate device. Neither is reachable from the developer's own session."
    tradeoff: "It gives the same local assurance as a hardware key. Every developer needs a second account or device for it."
choice:
  option: "a"
  reason: "An agent running as the developer's user can use unlocked signing agents or edit chant in `node_modules`, and it can skip the check entirely. A local rule alone therefore enforces nothing. Detection on the laptop plus enforcement at a boundary lets scenario 5 pass without new hardware for every developer, and #2524 lists preventing same-user local tampering as a non-goal."
rejected:
  - option: "b"
    why: "Local signatures would still need a sandboxed agent. A touch per signature costs every user for a guarantee CI already gives."
  - option: "c"
    why: "It needs a second principal on each machine. The enforcement boundary already gives that guarantee."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, Threat model"
    url: "https://github.com/INTENTIUS/chant/issues/2524#threat-model"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2547, attestors and policy read from the base revision"
    url: "https://github.com/INTENTIUS/chant/issues/2547"
    as_of: null
  - title: "INTENTIUS/chant#2548, write scope per member and agent sessions"
    url: "https://github.com/INTENTIUS/chant/issues/2548"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2547"
  - "INTENTIUS/chant#2548"
---

# Local promise
