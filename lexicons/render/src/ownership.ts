/**
 * The render lexicon's ownership convention, declared here so core carries no
 * render-specific branch — the #686 seam: each lexicon owns its key names; core
 * keeps only the generic stamp/detect logic (@intentius/chant/ownership).
 *
 * Render has no tags or labels on any resource. What it does have, on the two
 * kinds chant creates most and prunes — services and env groups — is a
 * key/value store the API writes and reads back verbatim: environment
 * variables. chant stamps `CHANT_MANAGED_BY=chant` (+ `CHANT_STACK` /
 * `CHANT_ENV`) into a service's or env group's env vars at serialize time and
 * reads them back through `GET .../env-vars`; that is the primary marker and
 * the basis for owned-only prune. A service without it is never modified or
 * deleted by a prune. The keys are upper-snake because that is what an env var
 * is; the values are exactly what every other lexicon stamps.
 *
 * Disks and custom domains carry no marker either, but they hang off a
 * service, so they inherit the parent's verdict — the service boundary, one
 * level down from fly's app boundary. An undeclared disk under a chant-owned
 * service is chant's and is pruned; one under a foreign service is foreign.
 *
 * Datastores, projects, environments, registry credentials, and webhooks
 * carry no channel and no boundary. Their verdict is `unknown` (never
 * `foreign`, never `owned`): the change set never escalates `unknown` to a
 * delete, so an undeclared Postgres is never pruned. Removing one is an
 * explicit `renderDelete` of a plan that names it.
 */

import type { ChannelKeys } from "@intentius/chant/ownership";

/** Env-var keys for chant's ownership markers on services and env groups. */
export const RENDER_ENV_OWNERSHIP_KEYS: ChannelKeys = {
  managedBy: "CHANT_MANAGED_BY",
  stack: "CHANT_STACK",
  env: "CHANT_ENV",
};

/** True when a key is one of chant's marker env vars. */
export function isOwnershipKey(key: string): boolean {
  return (
    key === RENDER_ENV_OWNERSHIP_KEYS.managedBy ||
    key === RENDER_ENV_OWNERSHIP_KEYS.stack ||
    key === RENDER_ENV_OWNERSHIP_KEYS.env
  );
}
