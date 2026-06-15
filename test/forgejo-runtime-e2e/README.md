# Forgejo runtime E2E

Proves a Forgejo runner actually **accepts and executes** chant's generated
`.forgejo/workflows/ci.yml` — not just that the YAML is well-formed (the
post-synth WFJ checks already cover that) or that the package installs (the
smoke tests cover that).

`src/pipeline.ts` is a minimal, dependency-free workflow (only `run:` shell
steps — no `uses:`, whose resolution is unit-tested; `runs-on: ubuntu-latest`,
which the dialect maps to the Forgejo `docker` label; two jobs with a `needs:`
edge). `build.ts` builds it to a real `.forgejo/workflows/ci.yml`;
`../forgejo-runtime-e2e.sh` then runs that workflow in Docker and asserts both
jobs run, in order (the `BUILD-OK` and `VERIFY-OK` markers).

Forgejo Actions run on the same engine as [`act`](https://github.com/nektos/act);
Forgejo's own runner is `forgejo-runner` / `act_runner`, whose `exec` subcommand
runs a workflow locally without a server. The script uses whichever of
`forgejo-runner`, `act_runner`, or `act` is on PATH.

## Run

```bash
just forgejo-runtime-e2e        # or: bash test/forgejo-runtime-e2e.sh
```

On-demand only. It needs Docker + a runner tool, so it is **not** part of the
gating CI; it cleanly skips (exit 0) when neither is available. Override the
image the `docker` label maps to with `FORGEJO_E2E_IMAGE`.
