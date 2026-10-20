# e2b steward

A steward profile and the template its sandbox is made from.

`chant.config.ts` declares a `prod` profile for hosted E2B whose `template` is
`chant-steward`. `src/steward.ts` declares that template. It starts from the
full `node:22-bookworm` image, which has the git and Node the runtime needs,
and adds `jq` and the GitHub CLI.

```bash
npm run build                     # writes dist/e2b.json and dist/e2b.chant-steward.Dockerfile
cd dist && e2b template create chant-steward --dockerfile e2b.chant-steward.Dockerfile --cpu-count 2 --memory-mb 2048
export E2B_API_KEY=e2b_... GITHUB_TOKEN=...
chant run <op> --on e2b           # the first run makes the steward from chant-steward
```

Rebuild the template when `src/steward.ts` changes. A steward that already
exists keeps its sandbox; delete it to have the next run make a new one from
the rebuilt template.
