// Per-instance identity, resolved once before any file is imported.
//
// `params.env` is "local" on a laptop and "pr-<n>" in the PR workflow (the CI
// job exports CHANT_ENV=pr-${{ github.event.number }}). Every physical name
// below interpolates it, so two open PRs deploy disjoint namespaces and
// workloads instead of walking over each other (COR021's collision).

import { params } from "@intentius/chant/params";

const env = params.env as string;

export const config = {
  env,
  /** One namespace per environment instance — the teardown unit. */
  namespace: `preview-${env}`,
  appName: `web-${env}`,
  // Tiny, public, pinned image that runs unprivileged — no registry access,
  // no root, binds 8080.
  appImage: "nginxinc/nginx-unprivileged:1.27-alpine",
  appPort: 8080,
};
