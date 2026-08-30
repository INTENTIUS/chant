# github-pr-preview

Per-PR preview environments on GitHub Actions: open a PR and get an isolated
live copy of the stack, push and the same copy updates, close the PR and it is
gone. Everything — the workload, the CI workflow, the teardown — is declared
in chant.

| Piece | Declared in | Emitted to |
|-------|-------------|------------|
| Workload (Namespace + WebApp) | `src/app/` | `dist/manifests.yaml` |
| PR workflow (deploy + teardown jobs) | `src/ci/` | `.github/workflows/preview.yml` |
| Deploy verb (build → plan → apply) | `ops/preview-apply.op.ts` | runs on the local Op executor |

Three declarations in `chant.config.ts` carry the loop:

- `environments: ["local", "pr-*"]` — the glob entry (#1221) makes every
  `pr-<n>` a legal environment with nothing to edit per PR.
- `buildParams.env` with `env: "CHANT_ENV"` — the workflow exports
  `CHANT_ENV=pr-<n>` once and every chant invocation in the job resolves the
  same validated value.
- `ownership: { stack: "pr-preview", env: { param: "env" } }` (#1396) — the
  ownership marker follows the parameter, so each PR's resources are stamped
  `chant.intentius.io/env: pr-<n>`. Teardown selects on exactly that marker.

The full walkthrough, including what this costs and which resource kinds not
to clone per PR, is the [Per-PR Preview Environments
tutorial](../../docs/src/content/docs/tutorials/github-pr-preview.mdx).

## Try it locally

Requires a reachable Kubernetes cluster (k3d is the cheapest:
`k3d cluster create preview`). Play both CI roles by hand:

```bash
npm install

# what the deploy job does for PR 42
CHANT_ENV=pr-42 npx chant run preview-apply

kubectl get all -n preview-pr-42

# what the teardown job does when PR 42 closes
npx chant lifecycle teardown pr-42 --yes
```

`preview-apply` is an `ApplyOp` on the local executor: `npm run build` renders
`dist/manifests.yaml` for the resolved env, the plan phase live-diffs it, and
the apply is a Kubernetes server-side apply as field manager
`chant:pr-preview`. Deletes are owned-only. The teardown is stateless — it
enumerates live resources carrying the marker and deletes exactly those, then
reports every outcome.

## The workflow

`npm run build:ci` emits `.github/workflows/preview.yml` from `src/ci/` — the
workflow is chant output, same as the manifests (dogfood). One workflow, two
jobs gated on the PR action:

- `deploy` (open / synchronize / reopen): checkout, `npm ci`, kubeconfig from
  the `preview` environment's `PREVIEW_KUBECONFIG` secret, `chant run
  preview-apply`, then a sticky PR comment.
- `teardown` (closed, merged or not): `chant lifecycle teardown pr-<n> --yes`.

The sticky comment is a scripted `gh api` step keyed on a hidden HTML marker
in the comment body: find the comment starting with the marker, PATCH it if it
exists, POST it otherwise. One comment per PR, updated in place across pushes,
and no marketplace action — nothing extra to pin, nothing the pinned-action
lints have to trust.

The emitted workflow passes the github lexicon's post-synth checks: every
`uses:` pinned to a full commit SHA, explicit least-privilege `permissions:`
per job, `timeout-minutes` everywhere, a per-PR concurrency group, and no
untrusted PR fields (title, branch name, body) anywhere near a `run:` script.
