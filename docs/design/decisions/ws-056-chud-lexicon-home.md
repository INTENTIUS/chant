---
schema: 1
id: "ws-056"
title: "Where the chud lexicon's parts go when chud retires"
state: "proposed"
area: "D19"
source:
  issue: "INTENTIUS/chant#2713"
  row: "The chud lexicon"
  revision: null
question: "When chud retires, where does each part of the chud lexicon go (its site resources, its release and supply-chain capabilities, its dispatch steps, its Op runtime and its receipts), so that a generated repo builds, deploys and runs a factory turn with no chud lexicon loaded?"
options:
  - id: "a"
    label: "split by the boundary: each part to what already does it, the dispatch runtime to the studio kit"
    how: "Site resources: `Chud::FlySite` becomes the fly lexicon's own app and Machine resources, which already have Machines activities and observation. `Chud::Site`, the local serving process, becomes the box itself: a docker lexicon Service in the kit's minimal preset, or a fountain lexicon `Box` (#2705), observed by that lexicon. Supply-chain capabilities (`release-build`, `release-sbom`, `release-scan`, `release-sign`, `release-verify`) become chant's starter verbs `docker-build`, `generate-sbom`, `scan-vulnerabilities`, `sign`, `verify` and `attest-provenance`. Release bookkeeping (`release-check`, `release-plan`, `site-record`, `rollback-plan`) becomes chant components with the release ledger and ws-055's plans on chant/lifecycle. `release-decision` (may a release skip the human gate) becomes a decision point (#2723). Site steps (`site-upload`, `site-migrate`, `site-start`, `site-verify`, `site-restore`, `site-rollback`) become the deploy target's own verbs: fly's for Fly, and the box's service for the local site. Migrations keep chant's receipt store, bound by the target (jhgaylor/chud#80). The dispatch steps (`dispatch-claim`, `dispatch-run`, `dispatch-check`, `dispatch-record`, `dispatch-abandon`) and the dispatch Op are runtime: they move to the studio kit, the thin layer, and write the workspace's lease and plan ledgers (ws-055). The Op runtime (`chant run --on chud`) is dropped: chant's local executor runs the Ops, and the site comes from the component's environments (#2696). `composites()` goes with whichever resources a composite groups. A generated repo moves off `@intentius/chant-lexicon-chud` through `chant workspace upgrade`."
    tradeoff: "Nothing is left that only chud holds, and nothing is written twice. chant keeps only specification: the release ledger, plans, decision points and verbs it already has. It is several moves across chant, the fly lexicon, the kit and a migration, and some chud verbs may carry behavior the starter verbs lack (the site's health-with-release check, the rollback plan's order), which has to be named and either added to chant or kept in the kit."
  - id: "b"
    label: "move the whole chud lexicon into the studio kit, unchanged"
    how: "The lexicon package moves from chud's runtime into arugula-salad/studio as the kit's own lexicon, renamed. Generated repos load it from the kit."
    tradeoff: "One move and no behavior change. It keeps a second supply-chain implementation beside chant's starter verbs, a second Fly site beside the fly lexicon, and an Op runtime beside chant's executor. It makes the thin layer thick, because the kit then carries specification (resource types, release bookkeeping) that belongs in the workspace."
  - id: "c"
    label: "move the whole chud lexicon into chant as a first-party lexicon"
    how: "The lexicon becomes `lexicons/site` (or similar) in INTENTIUS/chant, published with chant."
    tradeoff: "The site resources and release bookkeeping would be in chant, but so would the dispatch runtime and an Op runtime, which are not specification, and the duplicates of the starter verbs and the fly lexicon stay duplicated inside chant."
choice: null
rejected: []
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2713, where the chud lexicon's site, deploy and Op activities go"
    url: "https://github.com/INTENTIUS/chant/issues/2713"
    as_of: "2026-09-25T22:00:00Z"
  - title: "INTENTIUS/chant#2715, epic: retire chud"
    url: "https://github.com/INTENTIUS/chant/issues/2715"
    as_of: "2026-09-25T22:00:00Z"
  - title: "The chud lexicon: Chud::Site, Chud::FlySite, the capability plugin, the dispatch steps, the Op runtime (packages/runtime/src/lexicon.ts at jhgaylor/chud 43afcf1)"
    url: "https://github.com/jhgaylor/chud/blob/43afcf108d40a8b7b4c14544b8991451a5a56f2f/packages/runtime/src/lexicon.ts"
    as_of: "2026-09-25T22:00:00Z"
  - title: "chud's Op runtime, chant run --on chud (packages/runtime/src/lexicon-runtime.ts at 43afcf1)"
    url: "https://github.com/jhgaylor/chud/blob/43afcf108d40a8b7b4c14544b8991451a5a56f2f/packages/runtime/src/lexicon-runtime.ts"
    as_of: "2026-09-25T22:00:00Z"
  - title: "jhgaylor/chud#80, the site as a chant deploy target"
    url: "https://github.com/jhgaylor/chud/issues/80"
    as_of: "2026-09-25T22:00:00Z"
  - title: "chant's starter capabilities: docker-build, generate-sbom, scan-vulnerabilities, sign, verify, attest-provenance, health-gate, wait-endpoint, shell, run-agent"
    path: "packages/core/src/components/starter-plugin.ts"
    sha256: "8508a099edcf11c3487e5295ff54a85a065103caba9d323fc8bb11f15577c1e6"
  - title: "ws-055, decided option a: the development model's ledgers (leases and plans on chant/lifecycle), INTENTIUS/chant#2721"
    url: "https://github.com/INTENTIUS/chant/pull/2721"
    as_of: "2026-09-25T22:00:00Z"
decided_by: null
decided_on: null
reviews: []
constrains:
  - "INTENTIUS/chant#2713"
  - "member:core"
  - "path:lexicons/fly"
  - "path:packages/core/src/components"
x-recommendation:
  option: "a"
  reason: "It is the boundary rule applied part by part. Each piece already has a home that does the same job: chant's starter verbs, the fly lexicon, the release ledger and ws-055's plans, decision points, the box's own lexicon, and chant's executor. The dispatch runtime alone is left, and it is the thin layer's. Options b and c move the duplicates instead of removing them."
---

## Context

The chud lexicon is what a generated chud repo's `delivery/` loads to deploy and to run the factory. Retiring chud (#2715) means each of its parts needs a home. The rule is the one the epic states: specification goes in the workspace, the runtime and the experience in the studio kit, and what a person sees in hud.

## Recommendation

Option a. Most of the lexicon duplicates something chant already has:
- chant's starter verbs cover the supply chain;
- the fly lexicon covers Fly;
- the release ledger covers release bookkeeping.

The pieces that are new move into the workspace spec: plans (ws-055) and the release gate decision (#2723). The dispatch runtime goes to the kit.

## Implementation issues, if option a is chosen

1. Compare each chud supply-chain capability with its chant starter verb, and add to chant whatever behavior is missing.
2. Fly sites on the fly lexicon: release metadata on the Machine, and `components status --live` reading it.
3. The local site as the box's service, in the kit (arugula-salad/studio#27 and #42).
4. The release gate decision as a decision point (#2723).
5. The dispatch steps and Op into the studio kit, writing ws-055's ledgers.
6. A `chant workspace upgrade` migration that takes a generated repo off `@intentius/chant-lexicon-chud`.
