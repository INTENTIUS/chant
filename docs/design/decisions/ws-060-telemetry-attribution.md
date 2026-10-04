---
schema: 1
id: "ws-060"
title: "Telemetry attribution"
state: "decided"
area: "D22"
source:
  issue: "INTENTIUS/chant#2558"
  row: "Telemetry attribution"
  revision: null
question: "A span should name the declaration and release that produced it, so a reader can join it to a member, a release and a node of the workspace graph. Which attributes, who stamps them and when, and how is the place telemetry goes declared?"
options:
  - id: "a"
    label: "build stamps what it knows, the release step sets the rest"
    how: "A lexicon that declares workloads stamps `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` into each workload's environment when it builds inside a workspace. The build knows `service.name`, `chant.workspace`, `chant.member`, `chant.decl` and, with `--env` or `ownership.env`, `deployment.environment.name`. It adds `service.version` when the image is pinned by digest. `service.version` otherwise and `vcs.ref.head.revision` are set by what deploys the release. Where telemetry goes is a `telemetry` member link to a pipeline or exporter of the producer's collector, with an optional `protocol`, resolved by `chant workspace graph`."
    tradeoff: "Generated output stays a pure function of the declaration, so a commit that changes no workload changes no Compose file. A reader can only join on the release when the deploy step stamped it."
  - id: "b"
    label: "build stamps every attribute"
    how: "The build writes the git SHA and the artifact digest into each workload's environment."
    tradeoff: "Every attribute is present with no later step. Every commit changes every generated file, a digest is not known before the image is built, and a rebuild of the same source differs from the last."
  - id: "c"
    label: "document the variables, stamp nothing"
    how: "chant publishes the attribute names and each team sets them by hand."
    tradeoff: "Nothing to build. The hud spike (hud#466) found attribution to be the weak link, and by-hand values drift from the declaration."
choice:
  option: "a"
  reason: "The join needs the declaration's identity on the span, and only the build holds that identity. The release and the commit are facts of a deploy, not of a declaration, so they belong to the step that knows them. Keeping the build deterministic is what lets generated files stay committed."
rejected:
  - option: "b"
    why: "A build that embeds the SHA is different on every commit, and the digest of an image does not exist when its Compose file is written."
  - option: "c"
    why: "It leaves attribution to each team, which is the state #2558 set out to change."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2558, telemetry attribution"
    url: "https://github.com/INTENTIUS/chant/issues/2558"
    as_of: "2026-09-30T00:00:00Z"
  - title: "INTENTIUS/chant#2524, D22"
    url: "https://github.com/INTENTIUS/chant/issues/2524"
    as_of: "2026-09-30T00:00:00Z"
  - title: "ws-050, Collector config"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-050-collector-config.md"
    as_of: "2026-09-30T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-09-30"
reviews: []
constrains:
  - "INTENTIUS/chant#2558"
  - "INTENTIUS/chant#2559"
---

# Telemetry attribution

D22 of #2524 says each span carries resource attributes naming the declaration and release that produced it. This record fixes the attribute table, who stamps each attribute, and the link kind that says where telemetry goes.

## The attributes

| Attribute | Source | Joins to | Stamped by the build |
|---|---|---|---|
| `service.name` | the declaration's name | the service | yes |
| `service.version` | the release's artifact digest | the member's release ledger | when the image is pinned by digest |
| `deployment.environment.name` | the environment | the ledger's environment | with `--env` or `ownership.env` |
| `vcs.ref.head.revision` | the git SHA | the workspace revision (D15) | no, the deploy sets it |
| `chant.workspace` | the declaration's `name` | the workspace | yes |
| `chant.member` | the member name | the member | yes |
| `chant.decl` | the declaration id | the node in `chant workspace graph` | yes |

Semantic-convention names are used where they exist. The three `chant.*` attributes have no convention.

## How they are stamped

- A lexicon that declares workloads writes `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`, which every OpenTelemetry SDK reads. `OTEL_RESOURCE_ATTRIBUTES` is a comma-separated list of `key=value` pairs with percent-encoded values.
- The build resolves the facts once and hands them to each serializer as `SerializeContext.telemetry`. A lexicon turns them into variables for each workload with `telemetryEnvironment()`.
- A value the workload already sets is kept. Its own `OTEL_SERVICE_NAME` wins, and its own resource attributes keep their keys while missing ones are appended.
- `chant.decl` is the declaration id inside the member, which is the graph node id without the `<member>/` prefix. For docker it is the Compose service's key.
- The docker lexicon goes first. The k8s and fly lexicons follow, each as its own issue.

## When it applies

Inside a workspace, attribution is on, and `telemetry.attribution: false` in `chant.config.ts` turns it off. Outside a workspace it is off, and `telemetry.attribution: true` turns it on with the attributes that need no workspace. A project with no `chant.workspace.json` and no `telemetry` key resolves to nothing and its output is the same bytes as before. The check costs one upward `existsSync` walk, and the workspace declaration reader is imported only once a declaration is found.

## Where telemetry goes

The endpoint is a member link of a new kind, `telemetry`. The service's member is the consumer and the member that declares the collector is the producer. `output` names a pipeline id or an exporter id in the producer's collector, which the otel lexicon reports as `collectors` in `chant workspace graph` (#2559). An optional `protocol` (`grpc`, `http/protobuf` or `http/json`) says what the consumer sends.

`chant workspace graph` resolves the link:

- `resolved` when the collector has that pipeline or exporter, with `target` saying which.
- `missing` when it has not, or the producer declares no collector.
- `invalid` when the link states a protocol and the target's receivers (for a pipeline) or the exporter itself speak another.
- `unresolved` when the producer was not composed, or the target's definitions state no protocols.

`chant workspace check` reads source and runs no member, so it keeps the link unresolved (`WSP094`) and checks that `protocol` is only on a telemetry link (`WSP098`).

## What stays out

A composite that keeps these attributes intact is otel-side work in #2989 section 10 and follows this table. The check that a collector pipeline does not drop or overwrite them is the otel lexicon's OTEL118 (#3375), a post-synth warning that runs only when the build stamps the attribution.
