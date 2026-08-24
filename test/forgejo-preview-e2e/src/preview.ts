/**
 * The per-PR preview workflow the runtime E2E executes
 * (test/forgejo-preview-e2e.sh) — the forgejo-dialect twin of
 * examples/github-pr-preview's src/ci/, shrunk to what a local runner can
 * prove (chant #1223).
 *
 * Two jobs, gated on the PR action exactly like the tutorial's workflow:
 * `deploy` on open/synchronize/reopen, `teardown` on close. Each installs
 * chant from the tarballs the harness packs into ./packs (the runner copies
 * the whole fixture repo into the job container) and then runs the same two
 * verbs a real pipeline would: `chant run preview-apply` and
 * `chant lifecycle teardown pr-<n> --yes`.
 *
 * All env lives at workflow level: CHANT_ENV carries the PR's env name into
 * every chant invocation (the project's `buildParams.env` declares it as the
 * fallback), and FLY_FLAPS_BASE_URL points the fly applier and the teardown
 * sweep at the mudflaps container the harness put on the job network.
 */

import { Workflow, Job, Step } from "@intentius/chant-lexicon-forgejo";

export const workflow = new Workflow({
  name: "pr-preview-e2e",
  on: {
    pull_request: { types: ["opened", "synchronize", "reopened", "closed"] },
  },
  env: {
    CHANT_ENV: "pr-${{ github.event.number }}",
    FLY_FLAPS_BASE_URL: "http://mudflaps:4280",
  },
});

export const deploy = new Job({
  "runs-on": "ubuntu-latest",
  if: "github.event.action != 'closed'",
  steps: [
    new Step({
      name: "Install chant",
      run: "npm install --no-audit --no-fund ./packs/*.tgz",
    }),
    new Step({
      name: "Deploy preview environment",
      run: 'npx chant run preview-apply && echo "DEPLOY-OK $CHANT_ENV"',
    }),
  ],
});

export const teardown = new Job({
  "runs-on": "ubuntu-latest",
  if: "github.event.action == 'closed'",
  steps: [
    new Step({
      name: "Install chant",
      run: "npm install --no-audit --no-fund ./packs/*.tgz",
    }),
    new Step({
      name: "Tear down preview environment",
      run: 'npx chant lifecycle teardown "$CHANT_ENV" --yes && echo "TEARDOWN-OK $CHANT_ENV"',
    }),
  ],
});
