# design

The `design` data member (#2524 D18). It holds the design artifacts this workspace owns, apart from the design client in `../design-client`, so upgrading the client never writes over them.

| File | What it is |
|---|---|
| `screens/home.json` | the home screen's spec: its route, title and regions |
| `screens/home.svg` | a wireframe of the same screen |

The app in `../app` implements `screens/home.json`, and `ref-002` records why the spec lives here rather than in the app. That decision pins `screens/home.json` by the SHA-256 of its bytes in its `evidence` (#2549), so `chant workspace records` reports an edit to the file as `asset-drift` until the decision is revisited and the pin updated with `chant workspace records pin design/screens/home.json`.

A copy made with `chant init --from` fills the `{{chant:name}}` placeholder in both files, so the copy's bytes differ from the ones pinned here and the pin reports drift until the copy re-pins it.
