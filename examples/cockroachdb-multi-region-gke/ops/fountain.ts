/**
 * The steward for the prod estate: one writer for nine CockroachDB nodes.
 *
 * Four of this directory's Ops are listed. Two carry a cadence and become
 * `Schedule`s on the steward's thread — the converge tick that publishes the
 * UIs, and nothing else on a clock. `crdb-deploy` and `crdb-teardown` are
 * listed without one: they run when somebody asks, and listing them is what
 * tells `chant run crdb-deploy --on fountain` which thread the run belongs on.
 *
 * The thread is the point. A registrar delegation, a certificate that took an
 * hour, a teardown someone ran on a Friday — all of it is one conversation in
 * order, because every turn is one chant command line.
 */

import { params } from "@intentius/chant/params";
import {
  Environment,
  Repository,
  Steward,
  Vault,
} from "@intentius/chant-lexicon-fountain";
import crdbDeploy from "./deploy.op";
import crdbPublishUi from "./publish-ui.op";
import crdbUiConverge from "./publish-ui-converge.op";
import crdbTeardown from "./teardown.op";

/** The ownership marker, the same one `chant.config.ts` stamps on the estate. */
export const chantOwned = { "managed-by": "chant", stack: "crdb-multi-region" };

/** Everything the sandbox is allowed to reach: GKE, Cloud DNS, the estate, npm. */
export const toolchainEgress = {
  allowed_hosts: [
    "container.googleapis.com",
    "dns.googleapis.com",
    "github.com",
    "registry.npmjs.org",
  ],
};

/** The runtime the setup script installs chant with. */
export const toolchainPackages = { node: "24" };

// The computer the steward operates from. `gcloud` and `kubectl` come out of
// the setup script; the four contexts come from `scripts/kube-contexts.sh`,
// which every Op names explicitly rather than trusting an ambient current
// context. FTN010 requires the networking intent to be stated, and `limited`
// with an allowlist states it.
export const toolchain = new Environment({
  name: "crdb-toolchain",
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

// The GCP service-account key and the kubeconfigs. Values are set in fountain,
// never here: FTN001 refuses a literal secret and the API is write-only for
// values anyway.
export const prodCreds = new Vault({
  name: "crdb-prod-creds",
  description: "GCP credentials and kubeconfigs the prod ops run with.",
  metadata: chantOwned,
});

export const { agent, teammate, schedules } = Steward({
  name: "crdb-steward",
  environment: toolchain,
  vault: prodCreds,
  ops: [crdbDeploy, crdbUiConverge, crdbPublishUi, crdbTeardown],
});
