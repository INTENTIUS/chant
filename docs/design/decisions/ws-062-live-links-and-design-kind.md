---
schema: 1
id: "ws-062"
title: "Live links and the design kind"
state: "decided"
area: "D6, D18"
source:
  issue: "INTENTIUS/chant#2549"
  row: "Links, Network; Design apps"
  revision: null
question: "What does check --live resolve a member link against, and how does chant hold the design data member that D18 describes?"
options:
  - id: "a"
    label: "live graph; built-in design kind"
    how: "`chant workspace check --live --env <env>` reads the live graph of each member the way `chant workspace graph --live` does: each `chant` member runs `chant graph --live` under its own toolchain, and the outputs of that live graph (the stack outputs a lexicon's live read reports) are the names a declared `output` link may match, exactly. Two checks report it, WSP141 for an output the producer's estate does not publish and WSP142 for a link that could not be resolved live. `design` is a built-in member kind with a directory probe: a data member that chant reads for record pins and builds nothing."
    tradeoff: "No new transport, credentials or reader: the egress is the one `graph --live` already has, catalogued under the apply phase. A kind other than `chant` has no live reader yet, so its links stay unresolved. The built-in table grows by one kind that is not tied to a tool."
  - id: "b"
    label: "ledger-recorded outputs"
    how: "`check --live` reads the outputs a member's last deploy recorded on the `chant/lifecycle` branch, and never starts a member."
    tradeoff: "Nothing reaches a network and the read is fast. It answers what was last deployed from this checkout, not what is live now, and no ledger records a member's outputs today, so a new record type would come first."
  - id: "c"
    label: "kind from a package"
    how: "The `design` kind is published as a `./workspace-kinds` file by a kinds-only package that a declaration pins, as ws-031 says for kinds that belong to a tool."
    tradeoff: "It follows ws-031 to the letter. A design member has no tool to own the kind, and every workspace with one would pin and install a package whose only content is a directory probe."
choice:
  option: "a"
  reason: "D6 says `check --live` is catalogued egress and a link resolves in `source`, `live` or both, so the live side has to be what is deployed now. The live graph of #2875 is that read already, with its toolchain handling, environment flag and unreachable-account behaviour, so check reuses it instead of adding a second path to the account. The design kind is built in for the reason `examples` was in ws-051: no lexicon or tool exists to publish it, ws-031 puts kinds from tools in packages, and a probe that only asks for a directory needs nothing a package carries."
rejected:
  - option: "b"
    why: "It reports the last recorded deploy, not the estate, and needs a record of outputs nobody writes. A later slice can add it as a second source for the same rows."
  - option: "c"
    why: "A package that holds one directory probe is a release and a pin for nothing. If a design client package is published later, it can supply a richer kind then, and the built-in one stays the default."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2549, record links, asset pins, the design data member and check --live"
    url: "https://github.com/INTENTIUS/chant/issues/2549"
    as_of: "2026-09-30T00:00:00Z"
  - title: "INTENTIUS/chant#2524, D6. Links and D18. Design apps"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d6-links"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2875, workspace graph --live"
    url: "https://github.com/INTENTIUS/chant/issues/2875"
    as_of: null
  - title: "ws-031, Plugin shape"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-031-plugin-shape.md"
    as_of: null
  - title: "ws-024, Design app"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-024-design-app.md"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-30"
reviews: []
constrains:
  - "INTENTIUS/chant#2549"
  - "INTENTIUS/chant#2543"
---

# Live links and the design kind

## What check --live reads

`--live` needs `--env`, and refuses `--at`: a live read is of the account now. Each member of kind `chant` runs `chant graph --live --env <env>`, and the exports of the composed live graph are that member's outputs. Only declared links of kind `output` are resolved. A `telemetry` link names a collector target that the graph reports from source, so it stays a source-checked link.

The rows are the same rows `check` prints for source, with `resolves: "live"`, in `declaration.live.links`, with the environment in `declaration.live.env`. The source rows in `declaration.links` do not change.

## What the two checks mean

WSP141, a warning, is the case the live read answers: the producer was read, it published outputs, and none has the name. A declared output that is not deployed yet is a normal state before a release, so it is a warning that a workspace can raise to an error.

WSP142, info, is a link chant could not decide: the producer's kind has no live reader (`other`, `design`, a package kind), its member failed, or the live read returned no outputs at all. A lexicon whose live read reports no stack outputs, or an account that could not be reached (`chant graph --live` reports that as a warning and exits 0), looks the same from here, so an empty read is never reported as missing.

## The design kind

Kind `design` has a directory probe and precedence 0, so no probe of another kind is blocked and it claims nothing. It takes `outputs` from the entry like `other`, does not require a `because`, and is not reported by WSP009, since it is a named kind and not an unread directory. Per-member commands skip it with `kind-not-run` and a message that says it is data. Records pin its files by hash with the evidence `path` entry of #2653, and `chant workspace graph --intent` shows them, as they did for kind `other`.

A declaration that uses kind `design` needs chant 0.101.0: an older chant fails the member with `unknown-kind`.
