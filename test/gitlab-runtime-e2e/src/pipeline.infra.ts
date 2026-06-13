/**
 * Self-contained GitLab pipeline used by the runtime E2E (test/gitlab-runtime-e2e.sh).
 *
 * Deliberately minimal and dependency-free (alpine, no network beyond the base
 * image) so `gitlab-ci-local` can actually execute it in Docker. It exercises
 * the parts a runtime check should prove work end to end: an image pull, a
 * script, an artifact passed between jobs, and `needs:` ordering across stages.
 */

import { Job, Image, Artifacts } from "@intentius/chant-lexicon-gitlab";

const alpine = new Image({ name: "alpine:3.20" });

export const build = new Job({
  stage: "build",
  image: alpine,
  script: ['echo "built by chant" > out.txt'],
  artifacts: new Artifacts({ paths: ["out.txt"], expire_in: "1 hour" }),
});

export const verify = new Job({
  stage: "test",
  image: alpine,
  needs: ["build"],
  script: ["cat out.txt", 'grep -q "built by chant" out.txt'],
});
