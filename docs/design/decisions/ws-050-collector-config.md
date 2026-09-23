---
schema: 1
id: "ws-050"
title: "Collector config"
state: "decided"
area: "D22"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Collector config"
  revision: null
question: "Should chant declare OpenTelemetry collector config, and how?"
options:
  - id: "a"
    label: "typed lexicon with an extension point, readable by hud (#2559)"
    how: "An OTel lexicon types a core set of collector components and pipelines and serializes them to collector YAML. A typed extension point lets a team or plugin add components chant doesn't ship, and pipelines and endpoints appear in `chant workspace graph`."
    tradeoff: "hud and other readers get typed answers about where telemetry goes. chant takes on a lexicon to maintain, and it can't cover every vendor itself."
  - id: "b"
    label: "platform composites only"
    how: "Composites per platform deploy the collector, such as today's `GkeOtelCollector`, with no shared typed config."
    tradeoff: "Little new work. Each composite shapes config its own way, and readers get no typed view of it."
  - id: "c"
    label: "undeclared"
    how: "Collector YAML is left undeclared."
    tradeoff: "No work. Readers can't tell where any member's telemetry goes."
choice:
  option: "a"
  reason: "Collector config is declarative and has a schema, so chant can type it the way it types other config. The extension point covers components chant doesn't ship, and they lint and serialize like the built-ins. Typed pipelines let the telemetry endpoint be a declared member link (#2558), and hud reads it from `chant workspace graph`. Platform composites are built on the lexicon, and the GKE composite moves onto it (#2559). The source is ambiguous because the row was added after v8 with no revision marker, so the table doesn't show which revision introduced it."
rejected:
  - option: "b"
    why: "Composites without a shared typed config give hud no typed answers."
  - option: "c"
    why: "Undeclared YAML gives hud no typed answers either."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D22. Telemetry attribution"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d22-telemetry-attribution"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Collector config"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2559, typed OpenTelemetry collector config with an extension point"
    url: "https://github.com/INTENTIUS/chant/issues/2559"
    as_of: null
  - title: "INTENTIUS/chant#2558, telemetry attribution for spans, releases and declarations"
    url: "https://github.com/INTENTIUS/chant/issues/2558"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2559"
  - "INTENTIUS/chant#2558"
  - "INTENTIUS/chant#2536"
---

# Collector config
