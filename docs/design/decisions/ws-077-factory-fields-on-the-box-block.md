---
schema: 1
id: "ws-077"
title: "Factory fields on the box block"
state: "decided"
area: "D17"
source:
  issue: "INTENTIUS/chant#3146"
  row: "Factory fields on the box block (builds, check, builders, protected paths, publish target, plantable) replace studio's x-factory"
  revision: null
question: "Where does a workspace declare its factory (what it builds, how a build is checked, which member declares the builder agents, what a build may not change, where a finished build is published) and the box's listing, under which names, and how does a host tell that a workspace can be planted as one box, so that any orchestrator reads them through the read contract instead of studio's x-factory, delivery's studio config key and hud's database?"
options:
  - id: "a"
    label: "an opt-in factory block and a listing block on the box block, protected paths in writeScope, and plantable as a read-contract fact"
    how: "The box block takes factory: { builds, check, checks, builders, publish } and listing: { published, title, line, cover }. builds lists the members the factory builds, of any kind, and a work item a person asks for constrains member:<the first>. check is a command, or { run, kind } with kind one of test, build, lint, plan and conformance. checks is the directory where a builder writes an item's check. builders names the member that declares the builder agents; which agent builds at which tier is #3152, over the work kind's tiers (#3147). publish is { forge, repo, base, branchPrefix, head }: the branch <branchPrefix><item id> is pushed and a pull request opened on repo against base, from a fork when head names one. A declaration has one factory, and builds and builders name declared members, or it can't be read. What a build may not change is writeScope.<class>.protected, a glob or { path, except } per entry, enforced by check --changes with write-scope-protected and listed by chant workspace agent --json for a guard to apply to a build's diff. status --json prints factory and listing under each member's box with every default filled in, and the cover's sha256; graph --json prints them on each member, at a revision with --at. Both print plantable: { plantable, box, reason }, true when exactly one member's box block declares services, with box-none and box-several as reasons."
    tradeoff: "Every field is optional and validated only when present, so a records-only or infra workspace pays nothing (#3174), and the factory can build a Terraform estate checked by a plan as well as an app. Protected paths join the one write-scope model that check --changes already enforces, rather than a second list studio's guard alone reads. The orchestrator still runs the builder, the check and the push; chant only states them. A workspace that wants two factories, or a planter that wants to choose among several boxes, can't say so yet."
  - id: "b"
    label: "promote x-factory as it is: one box-block field per studio key"
    how: "The box block takes app, check, checks, agents, protected and apply under the names studio uses, with studio's defaults (app, delivery, <app>/checks)."
    tradeoff: "Studio's migration is a rename. The names and defaults are an app factory's (app, agents, apply), so an infra factory reads them as an app's, the defaults name members a workspace may not have, and protected paths stay a list only the guard reads, with no enforcement at the commit boundary."
  - id: "c"
    label: "a factory record kind in the reference workspace"
    how: "A factory.kind.mjs record holds the same fields as a decided record, so a change to the factory is proposed, reviewed and decided like any other."
    tradeoff: "The factory gets review and history through the records model. It is configuration of a member, not a decision, so a reader has to resolve the current record before it can plant a box, check can't tie builds and builders to the declared members while reading the declaration, and every workspace that builds must also declare the kind."
  - id: "d"
    label: "plantable as a WSP finding"
    how: "chant workspace check fails, or warns, when a workspace isn't plantable: no member's box block, or more than one, declares services."
    tradeoff: "A planter reads a check verdict. A records-only workspace or an infra workspace that runs its factory on a fountain steward is valid and isn't plantable, so the finding would be wrong for them, or suppressed by each of them."
choice:
  option: "a"
  reason: "#3145 moves everything studio needs into the spec, and ws-074 makes the repo the database: a box's factory and listing are configuration, so they belong in the declaration and change by review. The box block is where a box's other configuration already is (capabilities, isolation, intent, services), and the read contract already prints it, so status and graph carry the factory to hud, studio and any second orchestrator without a new command. The names are the general ones, because the factory is for ops too (#3146, #3174): builds names any member kind, check says whether it is a test, a plan or a lint, and publish covers an infra pull request. builders only names a member, so #3152 can add tiers without moving it, and the tier words are the work kind's (#3147). Protected paths go in writeScope because a write scope is what check --changes enforces at the commit boundary; a list only the guard reads protects nothing once the commit is made. A record file stays under records, since the verbs already say who may write which kind. Plantable is a fact, not a check, so the workspaces #3174 protects pass check and a planter reads one field instead of reimplementing studio's rule. head on publish covers a fork the whole workspace publishes from; a contributor's own fork is runtime the orchestrator supplies (arugula-salad/studio#242)."
rejected:
  - option: "b"
    why: "The names and defaults describe an app factory, which #3146's ops update rules out, and protected paths would stay unenforced at the commit boundary."
  - option: "c"
    why: "The factory is a member's configuration, not a decision. A record would make every reader resolve the current record before planting, and the declaration read couldn't check that builds and builders name declared members."
  - option: "d"
    why: "A records-only workspace and an infra workspace with no box services are valid (#3174); a finding would fail or need suppressing in each."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3146, factory fields on the box block"
    url: "https://github.com/INTENTIUS/chant/issues/3146"
    as_of: "2026-10-03T00:00:00Z"
  - title: "INTENTIUS/chant#3174, factory fields are opt-in, with ideation, app and infra profiles"
    url: "https://github.com/INTENTIUS/chant/issues/3174"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/studio#242, dogfood mode can't contribute from a fork"
    url: "https://github.com/arugula-salad/studio/issues/242"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/hud#729, unwind durable facts from .hud/events.db, the listing among them"
    url: "https://github.com/arugula-salad/hud/issues/729"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-074, the repo is the database"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-074-the-repo-is-the-database.md"
    as_of: "2026-10-03T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-03"
reviews: []
constrains:
  - "INTENTIUS/chant#3145"
  - "INTENTIUS/chant#3152"
  - "INTENTIUS/chant#3153"
  - "INTENTIUS/chant#3165"
  - "INTENTIUS/chant#3174"
  - "arugula-salad/hud#729"
  - "arugula-salad/studio#242"
  - "arugula-salad/studio#287"
  - "arugula-salad/studio#288"
  - "ws-067"
  - "ws-074"
---

# Factory fields on the box block
