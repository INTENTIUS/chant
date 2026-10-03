# design

The `design` data member (#2524 D18). It holds the design artifacts this workspace owns, apart from the design client in `../design-client`, so upgrading the client never writes over them.

| File | What it is |
|---|---|
| `screens/home.json` | the home screen's spec: its route, title and regions |
| `screens/home.svg` | a wireframe of the same screen |
| `sessions/session.kind.mjs` | the review-session record kind, with `session.schema.json` beside it |
| `sessions/S-0001-*.md` | the first review session, closed and sealed |
| `contracts/contract.kind.mjs` | the contract record kind, with `contract.schema.json` beside it |
| `contracts/C-001-*.md`, `contracts/checks/C-001.test.mjs` | a draft contract for the home page, and its check, which the contract pins by hash |
| `drivers/driver.kind.mjs` | the driver record kind, with `driver.schema.json` beside it |
| `drivers/D-001-*.md` | a driver grouping C-001 under one intent |
| `evidence/evidence.kind.mjs` | the evidence record kind, with `evidence.schema.json` beside it. It holds no records yet |

The app in `../app` implements `screens/home.json`, and `ref-002` records why the spec lives here rather than in the app. That decision pins `screens/home.json` by the SHA-256 of its bytes in its `evidence` (#2549), so `chant workspace records` reports an edit to the file as `asset-drift` until the decision is revisited and the pin updated with `chant workspace records pin design/screens/home.json`.

A copy made with `chant init --from` fills the `{{chant:name}}` placeholder in both files. Init then re-pins `ref-002` to the copy's `home.json`, so the pin holds in the copy too, and `workspace upgrade` does the same on each version it merges.

A review session (#2673) is a group walking an agenda of decisions together. Its file keeps the agenda, who attended with each principal's class (`person` or `agent`), when it opened and closed, and the verdicts it produced. Each verdict names a decision in `../decisions`, and the same verdict is an entry in that decision's `reviews` list whose `session` field names the session. Once closed, a session is sealed: `closed_digest` holds the whole-file seal, the SHA-256 of the session's JCS form without that field (#2546), and `chant workspace records --kind design/sessions/session.kind.mjs` reports `session-seal-mismatch` if the file changes afterwards. `--since <open commit> --at <close commit>` on either kind lists what the session did.

A session's verdicts judge decisions, contracts and drivers: the session kind names all three kinds as its subjects (#3148, [ws-082](../../docs/design/decisions/ws-082-design-record-kinds-contract-evidence-driver-and.md)). A verdict on a contract is also an entry in the contract's `reviews` list, which `chant workspace records review C-001 --session S-0002` writes into both files. A driver has no `reviews` list, so a sign-off on one is a verdict the session's writer appends with `records amend`. Each agenda item may carry the digest the record had when it was put up, the evidence records reviewed with it and any screenshot or recording.

A contract (`C-NNN-*.md`) states its criteria in the front matter, each with an id such as `a1`, and pins its check, a test file under `contracts/checks/` that runs against the app at `APP_URL`, where a test named `a1: ...` checks `a1`. It opens `draft`. Approving it sets `state: approved` and `approved_by`, after which only its state, its check pins and its reviews change; anything else is a new contract that `supersedes` it. A retired contract is final and sealed. A work kind links an item to the contract it builds with `work.contract` (#3147); this workspace's work items build none.

An evidence record is one run of one contract's check: the contract and its digest, the check's hash, the app's tree, the runner, and pass, fail or unchecked per criterion. `chant workspace records new design/evidence/evidence.kind.mjs --from <fields>` writes it as JSON named for the SHA-256 of its bytes, and it never changes afterwards. The run that holds a work item's lease attaches it to the item's criterion with `chant workspace work evidence <item> --from <entry>`, whose entry names the file by `path`.

A driver (`D-NNN-*.md`) groups contracts under one `intent`, with design notes in its body. Studio's agent proposals have no kind of their own: an agent proposes a work item, a lesson or a decision, each of which opens `proposed` with `proposed_by`, and a person keeps or drops it.
