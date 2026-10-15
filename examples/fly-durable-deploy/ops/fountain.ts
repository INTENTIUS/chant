/**
 * The steward that owns this Fly app.
 *
 * Durability here is not a workflow engine replaying a half-finished run. It
 * is a long-lived conversation and a convergent op: its sandbox keeps the
 * checkout and the tool cache across park and wake, and every turn re-applies
 * the whole plan.
 * A turn that dies halfway leaves the App and the Machine wherever it got to,
 * and the next fire — thirty minutes later, or a `chant run` someone types —
 * walks the same steps against that state and finishes the job. Nothing is
 * resumed because nothing needed to be: the deploy is the same shape at every
 * starting point.
 *
 * One conversation carries all of it, resumed by channel_id on every `chant
 * run --on fountain`, so it is this app's deploy history rather than a place
 * turns happen to appear. Managoat has no scheduler: the half-hourly cadence
 * runs from a clock outside it, a CI schedule or a CronJob that runs `chant
 * run fly-durable-deploy --on fountain`.
 */

import { params } from "@intentius/chant/params";
import {
  Environment,
  Repository,
  Steward,
  Vault,
} from "@intentius/chant-lexicon-fountain";
import flyDurableDeploy from "./fly-durable-deploy.op";

/** The ownership marker. Owned-only reconcile, prune and drift all key on it. */
export const chantOwned = { "managed-by": "chant" };

/** Everything the sandbox is allowed to reach: the Machines API, the estate, npm. */
export const toolchainEgress = {
  allowed_hosts: ["api.machines.dev", "github.com", "registry.npmjs.org"],
};

/** The runtime the setup script installs chant with. */
export const toolchainPackages = { node: "24" };

// The computer the steward deploys from: the estate repo, a chant to run it
// with, and egress narrow enough to review — the Machines API, the estate, and
// npm. FTN010 requires the networking intent to be stated; `limited` with an
// allowlist is the stated one.
export const toolchain = new Environment({
  name: "fly-toolchain",
  repositories: [
    new Repository({
      url: params.repoUrl as string,
      mount_path: "/workspace/estate",
      ref: "main",
    }),
  ],
  setup_script: "npm ci && npm install -g @intentius/chant",
  networking_type: "limited",
  networking_config: toolchainEgress,
  packages: toolchainPackages,
  metadata: chantOwned,
});

// FLY_API_TOKEN lives here, set in fountain and never in this file: FTN001
// refuses a literal secret, and the API is write-only for values anyway.
export const flyCreds = new Vault({
  name: "fly-creds",
  description: "The Fly API token the deploy runs with.",
  metadata: chantOwned,
});

// One writer for this app. The deploy op carries a half-hourly cron, which the
// steward's declaration lists for whatever clock fires it.
export const { agent } = Steward({
  name: "fly-steward",
  environment: toolchain,
  vault: flyCreds,
  ops: [flyDurableDeploy],
});
