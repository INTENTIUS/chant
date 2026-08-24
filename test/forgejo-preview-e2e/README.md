# Forgejo preview E2E (chant #1223)

Runtime proof of the per-PR preview loop: a chant-declared workflow whose
on-open job **deploys an isolated environment** and whose on-close job
**tears it down**, executed by a real Actions runner against a live emulator.
The forgejo-dialect twin of `examples/github-pr-preview`, shrunk to what a
local runner can prove.

`src/preview.ts` declares the workflow (forgejo lexicon): a `deploy` job gated
on `github.event.action != 'closed'` and a `teardown` job gated on
`== 'closed'`, both driven by one workflow-level `CHANT_ENV=pr-<n>`.
`project/` is the consuming chant project the jobs run inside — a fly App +
Machine whose names interpolate `params.env`, with `environments: ["local",
"pr-*"]` (#1221) and `ownership.env: { param: "env" }` (#1396), so the build
stamps `chant-env: pr-<n>` into the machine metadata and `chant lifecycle
teardown pr-<n> --yes` (#1222) sweeps exactly that.

`../forgejo-preview-e2e.sh`:

1. builds `.forgejo/workflows/preview.yml` from `src/`,
2. packs core + fly + temporal into tarballs the jobs `npm install`,
3. boots mudflaps (Fly Machines emulator) on a Docker network the job
   containers share (`http://mudflaps:4280`),
4. runs the workflow twice with stubbed `pull_request` payloads
   (`events/pr-opened.json`, `events/pr-closed.json`),
5. asserts from the host that the PR's app + marked machine exist on the
   emulator after the open run and are gone after the close run — and that
   the wrong job never fired on either event.

The events are stubbed payloads, not a live Forgejo server delivering
webhooks: the runner's `exec`-style local mode has no server to receive a
real PR, so `act -e <payload>` (or an `exec` that supports `--event-file`)
injects the event the same way the runner would receive it. Everything after
the injection — gate evaluation, step execution, the deploy, the sweep — is
the real path.

## Run

```bash
just forgejo-preview-e2e        # or: bash test/forgejo-preview-e2e.sh
```

On-demand only, **not** part of the gating CI. Needs Docker, network (the job
containers install transitive deps from the npm registry), and a runner that
can inject a PR event payload (`act`, or a `forgejo-runner`/`act_runner`
whose `exec` supports `--event-file`); anything missing is a clean skip.
Override the job image with `FORGEJO_E2E_IMAGE` (must have node, npm, and
git — `chant run` expects a git repo, like a real runner checkout).
