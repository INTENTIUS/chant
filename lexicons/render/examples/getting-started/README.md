# render getting-started

A Postgres database and a web service wired to it, declared as typed TypeScript and applied straight to a Render workspace over the Public API.

```bash
export RENDER_API_KEY=rnd_…       # Account Settings → API Keys
export RENDER_OWNER_ID=tea-…      # workspace id (optional when the key sees exactly one)

npm run build        # chant build src --lexicon render -o dist/render.json  (lint + plan, no API calls)
chant run render     # build → renderApply: creates both, waits the web service's deploy to live
```

Re-running `chant run render` is idempotent: everything reports `unchanged` until you edit `src/infra.ts`. To tear it down, `renderDelete` the same plan (or add `teardown: true` to the Op).
