/**
 * Self-contained Forgejo workflow used by the runtime E2E
 * (test/forgejo-runtime-e2e.sh).
 *
 * Deliberately minimal and dependency-free — only `run:` shell steps, no
 * `uses:` (action resolution is unit-tested) — so a Forgejo runner can execute
 * it without network. It exercises the parts a runtime check should prove work
 * end to end: the `runs-on` label the dialect maps to (`ubuntu-latest` →
 * `docker`), step ordering within a job, and `needs:` ordering across jobs.
 */

import { Workflow, Job, Step } from "@intentius/chant-lexicon-forgejo";

export const workflow = new Workflow({
  name: "ci",
  on: { push: { branches: ["main"] } },
});

export const build = new Job({
  "runs-on": "ubuntu-latest",
  steps: [
    new Step({ name: "write", run: 'echo "built by chant" > out.txt' }),
    new Step({ name: "check", run: 'grep -q "built by chant" out.txt && echo "BUILD-OK"' }),
  ],
});

export const verify = new Job({
  "runs-on": "ubuntu-latest",
  needs: ["build"],
  steps: [new Step({ name: "verify", run: 'echo "VERIFY-OK ran after build"' })],
});
