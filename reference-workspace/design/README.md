# design

The `design` data member (#2524 D18). It holds the design artifacts this workspace owns, apart from the design client in `../design-client`, so upgrading the client never writes over them.

| File | What it is |
|---|---|
| `screens/home.json` | the home screen's spec: its route, title and regions |
| `screens/home.svg` | a wireframe of the same screen |
| `sessions/session.kind.mjs` | the review-session record kind, with `session.schema.json` beside it |
| `sessions/S-0001-*.md` | the first review session, closed and sealed |

The app in `../app` implements `screens/home.json`, and `ref-002` records why the spec lives here rather than in the app. That decision pins `screens/home.json` by the SHA-256 of its bytes in its `evidence` (#2549), so `chant workspace records` reports an edit to the file as `asset-drift` until the decision is revisited and the pin updated with `chant workspace records pin design/screens/home.json`.

A copy made with `chant init --from` fills the `{{chant:name}}` placeholder in both files. Init then re-pins `ref-002` to the copy's `home.json`, so the pin holds in the copy too, and `workspace upgrade` does the same on each version it merges.

A review session (#2673) is a group walking an agenda of decisions together. Its file keeps the agenda, who attended with each principal's class (`person` or `agent`), when it opened and closed, and the verdicts it produced. Each verdict names a decision in `../decisions`, and the same verdict is an entry in that decision's `reviews` list whose `session` field names the session. Once closed, a session is sealed: `closed_digest` holds the SHA-256 of the file without that line, and `chant workspace records --kind design/sessions/session.kind.mjs` reports `session-seal-mismatch` if the file changes afterwards. `--since <open commit> --at <close commit>` on either kind lists what the session did.
