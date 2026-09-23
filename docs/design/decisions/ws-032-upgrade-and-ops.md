---
schema: 1
id: "ws-032"
title: "Upgrade and Ops"
state: "decided"
area: "D9"
source:
  issue: "INTENTIUS/chant#2524"
  row: "Upgrade and Ops"
  revision: null
question: "Does a workspace upgrade run as a core command or as an Op that the template ships?"
options:
  - id: "a"
    label: "command plus activity"
    how: "The upgrade is a core command, `chant workspace upgrade <scope>`. A propose-only activity lets an Op, including a workspace Op, run it on a schedule and open a PR, as the `lexiconUpgrade` activity does today."
    tradeoff: "One upgrader serves every template and is gated by the rules at HEAD. A scheduled Op may only propose, since it never rewrites itself."
  - id: "b"
    label: "template Op"
    how: "Each template ships an Op that performs its own upgrade."
    tradeoff: "The template author controls the upgrade. Each template and each fork would carry its own upgrader."
  - id: "c"
    label: "command only"
    how: "The upgrade runs only when someone calls `chant workspace upgrade`."
    tradeoff: "Simplest. Nothing schedules upgrades, so workspaces fall behind their template until someone runs the command."
choice:
  option: "a"
  reason: "D9 makes the upgrade a core command so that governance changes are gated by the rules already at HEAD. The v6 text adds that a template-shipped Op would need a two-run bootstrap. The propose-only activity keeps scheduled upgrades without letting the Op rewrite itself."
rejected:
  - option: "b"
    why: "An Op that upgrades its own template rewrites its own gate policy between gate runs, so the change could loosen the gates that judge it."
  - option: "c"
    why: "Without the activity nothing can schedule upgrades or open them as PRs."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2524, D9. Templates and upgrade"
    url: "https://github.com/INTENTIUS/chant/issues/2524#d9-templates-and-upgrade"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2524, Decisions table, row Upgrade and Ops"
    url: "https://github.com/INTENTIUS/chant/issues/2524#decisions"
    as_of: "2026-09-23T20:56:42Z"
  - title: "INTENTIUS/chant#2550, migrations and chant workspace upgrade"
    url: "https://github.com/INTENTIUS/chant/issues/2550"
    as_of: null
decided_by: "lex00"
decided_on: "2026-09-23"
reviews: []
constrains:
  - "INTENTIUS/chant#2550"
---

# Upgrade and Ops
