// The on-close half of the loop. Runs for every close — merged or abandoned —
// and sweeps the PR's environment by its ownership marker.
//
// `chant lifecycle teardown` is stateless: it enumerates live resources
// carrying stack `pr-preview` + env `pr-<n>` and deletes exactly those. No
// snapshot, no state file — resources deployed by a run of a workflow that
// has since been rewritten are still found, because the marker lives on the
// resources themselves. The prod guard does not fire for `pr-*` names, so
// `--yes` is enough to run non-interactively.

import { Job, Step, Environment, Permissions } from "@intentius/chant-lexicon-github";
import { checkout, setupNode, install, clusterAccess } from "./setup";

export const teardown = new Job({
  "runs-on": "ubuntu-latest",
  if: "github.event.action == 'closed'",
  "timeout-minutes": 10,
  permissions: new Permissions({ contents: "read" }),
  environment: new Environment({ name: "preview" }),
  steps: [
    checkout,
    setupNode,
    install,
    clusterAccess,
    new Step({
      name: "Tear down preview environment",
      run: 'npx chant lifecycle teardown "$CHANT_ENV" --yes',
    }),
  ],
});
