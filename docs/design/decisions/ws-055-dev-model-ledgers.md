---
schema: 1
id: "ws-055"
title: "What a development model tracks goes in the workspace's ledgers"
state: "proposed"
area: "D7"
source:
  issue: "INTENTIUS/chant#2717"
  row: "Ledgers for a development model"
  revision: null
question: "Where does a workspace keep what a development model tracks over time (who holds which work item, what a release shipped, which items can be built now, which effects fired on a site), so that the specification can answer it without chud's code?"
options:
  - id: "a"
    label: "extend chant's existing lease and ledgers: a work lease beside the operator lease, plans on chant/lifecycle, readiness from the work kind, receipts unchanged"
    how: "Leases: chant's operator lease (`lifecycle/lease.ts`, a compare-and-set ref at `refs/chant/lease/<op>` holding a lease-record blob, with a fencing token, a time to live, renew and release, pushed and fetched through the remote) gains a work-item key, `refs/chant/lease/work/<id>`, written by `chant workspace work claim|renew|release <id>` with a holder and a time to live. Every claim, renew and release also appends a line to `_leases/<id>.jsonl` on chant/lifecycle, so the history is a ledger like `_gates`, and the read contract reports each work item's active lease (holder, expiry, token) in `records --json` and `workspace status`. Plans: a release plan is written content-addressed to `_plans/<digest>.json` on chant/lifecycle, and the release ledger record already names that digest. Readiness: the ready queue is the work kind's `ready` and `blockedBy`, with a contract's readiness written as the work item's `needs`; a rule the work kind cannot express is named and stays with the runner. Receipts: unchanged. chant's `ReceiptStore` is the interface, a remote site already keeps its receipts on its chant/lifecycle branch, and D7 already scopes receipts per member; the deploy target of jhgaylor/chud#80 implements the store."
    tradeoff: "Reuses code that already has the semantics chud needs (atomic across processes and clones, fencing, expiry) and the ledger shape every other lifecycle store uses; D7 already lists leases and receipts among the scoped stores. It adds three CLI verbs, one ledger directory, one plan directory and lease fields in the read contract. The lease is coordination, not a record of work, so it never touches the working branch, which keeps it out of release and write-scope checks as chud's own design wanted."
  - id: "b"
    label: "leases and plans stay with the runner, as today"
    how: "Whatever runs the work (chud today, a thin studio layer after it) keeps leases on its own branch and plans in its own directory, in its own formats. chant reads nothing of them; the release ledger keeps naming a plan digest it cannot resolve."
    tradeoff: "No chant change. The workspace cannot say who is working on what or what a release contained without the runner's code, which is the gap the chud retirement (INTENTIUS/chant#2715) exists to close; a second runner would invent a second format."
  - id: "c"
    label: "leases as fields on the work item record"
    how: "A claim sets `claimed_by` and `expires_at` on the work item through `records amend`, and a release clears them."
    tradeoff: "Nothing new to read. It is wrong in the ways chud's own leases.mjs lists: a commit on the working branch is not atomic across clones, two workers can both commit a claim, every heartbeat is a commit in the history, and the claim falls inside the release's nothing-to-ship test and the write-scope policy's range."
choice: null
rejected: []
supersedes: []
evidence:
  - title: "INTENTIUS/chant#2717, the workspace keeps what a development model tracks in ledgers"
    url: "https://github.com/INTENTIUS/chant/issues/2717"
    as_of: "2026-09-25T21:00:00Z"
  - title: "INTENTIUS/chant#2715, epic: retire chud"
    url: "https://github.com/INTENTIUS/chant/issues/2715"
    as_of: "2026-09-25T21:00:00Z"
  - title: "INTENTIUS/chant#2524 D7. Ledgers: leases and receipts among the scoped stores on chant/lifecycle"
    url: "https://github.com/INTENTIUS/chant/issues/2524"
    as_of: "2026-09-25T21:00:00Z"
  - title: "chud's leases: a claim with an expiry on the chud/leases branch, compare-and-swap through update-ref, pushed for workers in separate clones (packages/runtime/src/leases.mjs at jhgaylor/chud 43afcf1)"
    url: "https://github.com/jhgaylor/chud/blob/43afcf108d40a8b7b4c14544b8991451a5a56f2f/packages/runtime/src/leases.mjs"
    as_of: "2026-09-25T21:00:00Z"
  - title: "chud's release ledger names the plan by digest, and the plan lives in .chud/plans (packages/runtime/src/ledger.mjs at 43afcf1)"
    url: "https://github.com/jhgaylor/chud/blob/43afcf108d40a8b7b4c14544b8991451a5a56f2f/packages/runtime/src/ledger.mjs"
    as_of: "2026-09-25T21:00:00Z"
  - title: "chud's receipts: a local store, and a remote site's receipts on its chant/lifecycle branch (packages/runtime/src/receipts.mjs at 43afcf1)"
    url: "https://github.com/jhgaylor/chud/blob/43afcf108d40a8b7b4c14544b8991451a5a56f2f/packages/runtime/src/receipts.mjs"
    as_of: "2026-09-25T21:00:00Z"
  - title: "chant's operator lease: refs/chant/lease/<op>, compare-and-set, fencing token, renew and release"
    path: "packages/core/src/lifecycle/lease.ts"
    sha256: "86af897db14c73ef2bb2d506ecd0e82244f630393515d45f63a376ee7b9e092d"
  - title: "chant's gate ledger: the append-only _gates/<op>.jsonl shape on chant/lifecycle"
    path: "packages/core/src/lifecycle/gate-ledger.ts"
    sha256: "e6cd48769ecca5a2b735dc859d7e96da3f351ec68f36554c4f7cdafdf4cf0994"
  - title: "chant's release ledger"
    path: "packages/core/src/lifecycle/release-ledger.ts"
    sha256: "59ceb1135d6272e0f9154169f31a41c26b824dacebb32ecfc12a8fd8266dfa1d"
  - title: "chant's receipt store interface"
    path: "packages/core/src/op/receipt-store.ts"
    sha256: "275c3b3f9a2647a736058a055f0504318f44abca7e3de98d6bec9c55a8f495d3"
decided_by: null
decided_on: null
reviews: []
constrains:
  - "INTENTIUS/chant#2717"
  - "member:core"
  - "path:packages/core/src/lifecycle"
  - "path:packages/core/src/workspace"
x-recommendation:
  option: "a"
  reason: "Every piece has a chant home to extend. The operator lease already has chud's lease semantics (atomic across clones, expiry, fencing); the ledger shape and chant/lifecycle already hold releases and gates, and D7 already names leases and receipts among the scoped stores; the work kind already derives readiness. Options b and c leave the workspace unable to answer who holds what, or put coordination on the working branch."
---

## Context

The chant workspace is a specification: declarations, record kinds, and ledgers for what happens over time. The studio kit is the thin layer that runs things against it (INTENTIUS/chant#2715, lex00 on 2026-09-25). chud tracks four things outside chant today. This record decides where they go.

## Recommendation

Option a, because each piece already has a chant home to extend:

- **Leases.** The operator lease has chud's semantics already, including atomic claims across clones, expiry and fencing. Taking a lease, heartbeating while an agent builds and releasing it stay with the runner, which calls the new verbs.
- **Plans.** Release plans join the release ledger they are already named from.
- **Readiness.** The ready queue is the work kind's own derivation.
- **Receipts.** They need nothing new.

## Implementation issues, if option a is chosen

1. The work lease: `chant workspace work claim|renew|release`, `refs/chant/lease/work/<id>`, the `_leases/<id>.jsonl` history, and lease fields in `records --json` and `workspace status`.
2. Release plans on chant/lifecycle at `_plans/<digest>.json`, resolved from the release ledger by the read contract.
3. The factory's readiness rules checked against the work kind. Each rule the work kind cannot express is listed, with where it lives instead.
