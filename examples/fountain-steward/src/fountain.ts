/**
 * A fountain steward: one writer for the prod environment (chant #2115).
 *
 * The `Steward` composite turns three declarations into the whole operating
 * surface for one environment — an Agent that speaks ACP over `chant acp`, a
 * Teammate seat so it has a standing conversation, and one Schedule per op
 * that carries a cadence. Every run of every op listed below lands on that one
 * thread, which is what makes the thread the environment's history rather than
 * a place turns happen to appear.
 *
 * `chant init --lexicon fountain --template steward` scaffolds this shape.
 */

import { params } from "@intentius/chant/params";
import {
  Environment,
  Repository,
  Steward,
  Vault,
} from "@intentius/chant-lexicon-fountain";
import { prodConverge } from "./prod-converge.op";
import { prodWatch } from "./prod-watch.op";
import { stewardApply } from "./steward-apply.op";

/** The ownership marker. Owned-only reconcile, prune and drift all key on it. */
export const chantOwned = { "managed-by": "chant" };

/** Everything the sandbox is allowed to reach: the estate, and npm. */
export const toolchainEgress = { allowed_hosts: ["github.com", "registry.npmjs.org"] };

/** The runtime the setup script installs chant with. */
export const toolchainPackages = { node: "24" };

// The computer the steward operates from: the estate repo, a chant to run it
// with, and egress narrow enough to be worth reviewing. FTN010 requires the
// networking intent to be stated; `limited` with an allowlist is the stated
// one, and an empty allowlist would be deny-all rather than allow-all.
export const toolchain = new Environment({
  name: "prod-toolchain",
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

// One vault per environment, so the steward can only ever attach its own.
// Values are set in fountain, never here: FTN001 refuses a literal secret and
// the API is write-only for values anyway. Under an egress broker, drop this
// and the `vault:` line below — the broker holds the credentials.
export const prodCreds = new Vault({
  name: "prod-creds",
  description: "Credentials the prod ops run with.",
  metadata: chantOwned,
});

// The one writer. Two Schedules come out of this — one per op with a cadence —
// plus the Agent and the Teammate seat that owns the thread. `steward-apply`
// has no cadence and gets no Schedule, and is listed anyway so a run of it
// knows which thread it belongs on.
export const { agent, teammate, schedules } = Steward({
  name: "prod-steward",
  environment: toolchain,
  vault: prodCreds,
  ops: [prodWatch, prodConverge, stewardApply],
});
