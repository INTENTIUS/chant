# GitLab runtime E2E

Proves GitLab CI actually **accepts and executes** chant's generated
`.gitlab-ci.yml` — not just that the YAML is well-formed (the post-synth WGL
checks already cover that) or that the package installs (the smoke tests cover
that).

`src/pipeline.infra.ts` is a minimal, dependency-free pipeline (alpine image, a
script, an artifact, a `needs:` edge). `build.ts` builds it to a real
`.gitlab-ci.yml`; `../gitlab-runtime-e2e.sh` then runs that pipeline in Docker
with [`gitlab-ci-local`](https://github.com/firecow/gitlab-ci-local) and asserts
both jobs run and the artifact crosses the `needs:` edge.

`gitlab-runner exec` is deliberately not used — it was removed in
gitlab-runner 16.0. `gitlab-ci-local` is the maintained local runner.

## Run

```bash
just gitlab-runtime-e2e        # or: bash test/gitlab-runtime-e2e.sh
```

On-demand only. It needs Docker + network, so it is **not** part of the gating
CI; it cleanly skips (exit 0) when Docker is unavailable.
