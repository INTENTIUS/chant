---
schema: 1
id: "ws-017"
title: "Read contract"
state: "decided"
area: "D15"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Read contract"
  revision: null
question: "What contract do tools such as behold and hud use to read a workspace?"
options:
  - id: "a"
    label: "format, schemas, codes"
    how: "The contract is a versioned declaration format with published JSON Schemas for each command's output. It adds a closed list of reason codes and a minimum version per contract version, and MCP tools wrap the same JSON."
    tradeoff: "Every tool shares one documented surface and may parse the declaration on its own. The schemas have to be versioned and published, and the code list kept closed."
  - id: "b"
    label: "CLI JSON"
    how: "Readers parse whatever JSON the CLI prints, with no published schema."
    tradeoff: "Nothing has to be written up front. Any output change can break a consumer without warning."
  - id: "c"
    label: "library"
    how: "Each tool imports a library API and calls it in its own process."
    tradeoff: "Calls are typed. Each tool is tied to the one version it loads."
  - id: "d"
    label: "daemon"
    how: "A long-running process answers workspace reads over a local API."
    tradeoff: "Reads stay warm. There is one more service to run and secure."
choice:
  option: "a"
  reason: "Every consumer needs the same facts, and one versioned contract lets each of them check a version floor and explain an old install to the user. Tools may parse the declaration themselves, so a Terraform-only estate stays viewable without chant. MCP wraps the same JSON documents for agents, so there is one API."
rejected:
  - option: "b"
    why: "Undocumented output gives consumers nothing to pin to. A release could then break behold or hud without notice."
  - option: "c"
    why: "Members pin different versions, and behold already reads each member as a subprocess of its own toolchain. An in-process library would tie the viewer to one version."
  - option: "d"
    why: "A daemon adds a service to run and secure. Consumers would still need a documented format for its answers."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D15. Artifact and read contract"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d15-artifact-and-read-contract"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, D11. behold"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d11-behold"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2536, the read contract, with output schemas, reason codes and --at"
    url: "https://github.com/INTENTIUS/chant/issues/2536"
    as_of: null
  - title: "INTENTIUS/behold#464"
    url: "https://github.com/INTENTIUS/behold/issues/464"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2536"
  - "INTENTIUS/behold#464"
  - "INTENTIUS/github-warden#62"
  - "INTENTIUS/chant#2555"
---

# Read contract
