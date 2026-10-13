---
schema: 1
id: "ws-100"
title: "A box declares how it ships, and status says what its site serves and what is waiting"
state: "decided"
area: "D17"
source:
  issue: "arugula-salad/studio#53"
  row: "staged, shipped, kept: contributors see the work at once, everyone else sees the last release, and a person ships from hud's deploy menu"
  revision: null
question: "A box's people see its working tree at once and everyone else sees the last release; a person ships. How does a surface such as hud learn that a box can ship, what to run to ship it, which gate a person approves, which commit the box's site serves, and how many changes are waiting, without a variable in the box's environment or a reading of the orchestrator's own files?"
options:
  - id: "a"
    label: "the box block names its ship Op, and status --json reports what the site serves and what is pending"
    how: "The box block takes ship: { op, gate, env, bookkeeping }. op is the Op in the box member that ships; its own steps (the orchestrator's) commit the staged tree as one commit by the person shipping, named to it in CHANT_SHIP_BY, with a Chant-Record trailer for each work item it lands, then release that commit to the box's site, stopping at gate (ship when omitted), and record the release in env's release ledger under the box member (box when omitted). status --json prints it under the member's box with serving, the latest release in that ledger (commit, digest, component, at, actor), and pending, the files that differ between serving.commit and the working tree, tracked or untracked and not ignored, with the bookkeeping path prefixes left out (files, and up to 200 sorted paths). A surface offers Ship when ship is set, shows pending.files, runs chant run <op> in the member's directory and approves gate through its usual gate flow."
    tradeoff: "A surface reads everything from the read contract it already uses, and the count comes from the same ledger every release reader trusts. chant runs nothing new: the commit and the release are the Op's steps, which the orchestrator writes. pending counts files, not agent turns, so a turn that touches nothing outside bookkeeping adds nothing and two turns on one file count once. CHANT_SHIP_BY is a variable, but it is the Op's input from the surface, not the box's configuration."
  - id: "b"
    label: "the template declares a component whose deploy runs the release, so the existing deploy menu lists it"
    how: "studio's template adds a box-site component and a composite for the box's site; hud's menu, built from graph --composites, offers it, and its deploy runs the release."
    tradeoff: "No chant change. A component's deploy is a supply chain, not an Op with a person's gate, and the menu would carry no count; a component built only to appear in a menu misstates what the box declares."
  - id: "c"
    label: "the box's run script hands the surface a ship command, as HUD_APPLY_CMD once did"
    how: "studio's run-daemon.sh sets a HUD_SHIP_CMD and a HUD_SHIP_COUNT_CMD for hud to spawn."
    tradeoff: "No chant change, and studio can change the commands freely. It brings back the environment glue ws-088 removed, and a surface in a box studio did not start has no way to learn them."
choice:
  option: "a"
  reason: "ws-088 already put the box's publisher on its box block for the same reason: a box's configuration belongs in its declaration (ws-074), and status --json is where every surface reads the box. Naming the ship Op there lets hud offer Ship from the read contract, and the gate is an Op gate like any other, so hud's existing gate flow approves it. serving comes from the release ledger chant already reads for status <env>, not from a file on the box's disk, and pending is a plain diff against that commit, so any reader gets the same number. The commit is the Op's because chant never commits (ws-074); the person is passed in, and the commit carries Chant-Record trailers (ws-075). Bookkeeping is declared rather than inferred, because only the workspace knows which paths are its records."
rejected:
  - option: "b"
    why: "A component and composite made only to appear in a menu would say something the box does not mean, would have no gate a person approves, and would give the menu no count."
  - option: "c"
    why: "It reintroduces the environment-injected glue that ws-088 removed, against ws-074, and a surface outside studio's boxes could not learn the commands."
supersedes: []
evidence:
  - title: "arugula-salad/studio#53, staged, shipped, kept"
    url: "https://github.com/arugula-salad/studio/issues/53"
    as_of: "2026-10-04T00:00:00Z"
  - title: "ws-088, a box publishes through one chant call to the publisher it declares"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-088-a-box-publishes-through-one-chant-call-to-the-pu.md"
    as_of: "2026-10-04T00:00:00Z"
  - title: "studio's template/box/ops/release.op.ts, the box's release to its own site past the ship gate"
    url: "https://github.com/arugula-salad/studio/blob/integration/next/template/box/ops/release.op.ts"
    as_of: "2026-10-04T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-04"
reviews: []
constrains:
  - "arugula-salad/studio#53"
  - "ws-074"
  - "ws-075"
  - "ws-088"
  - "member:core"
  - "path:packages/core/src/workspace/status.ts"
---

# A box declares how it ships, and status says what its site serves and what is waiting

A box's people see its working tree at once and everyone else sees the last release. The box block names the Op that ships its staged work (`ship.op`), the gate a person approves (`ship.gate`, `ship` by default), the environment whose release ledger records each release (`ship.env`, `box` by default) and the path prefixes that are bookkeeping. `chant workspace status --json` prints it under the member's `box` with `serving`, the latest release in that ledger, and `pending`, the files that differ between that commit and the working tree, bookkeeping left out.

The Op's own steps commit the staged tree as one commit by the person shipping (passed in `CHANT_SHIP_BY`), with a `Chant-Record` trailer for each work item it lands, release that commit, and record it. chant runs none of that. A surface offers Ship when `ship` is set, shows `pending.files`, runs `chant run <op>` in the member's directory, and approves the gate as for any Op.
