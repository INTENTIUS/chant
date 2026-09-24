# design

The `design` data member (#2524 D18). It holds the design artifacts this workspace owns, apart from the design client in `../design-client`, so upgrading the client never writes over them.

| File | What it is |
|---|---|
| `screens/home.json` | the home screen's spec: its route, title and regions |
| `screens/home.svg` | a wireframe of the same screen |

The app in `../app` implements `screens/home.json`, and `ref-002` records why the spec lives here rather than in the app. Nothing links a record to these files yet. Once #2549 lands, a record links to a region by anchor (such as `screens/home.json#status`) and pins the file's hash when it closes.
