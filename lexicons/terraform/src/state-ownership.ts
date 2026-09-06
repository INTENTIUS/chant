/**
 * Terraform's ownership channel (#2087) — the state file.
 *
 * Its own module, and a tiny one, for the same reason cedar's
 * `src/avp/ownership.ts` is: `plugin.ts` declares `ownershipChannel` eagerly
 * while `describeResources` is behind a dynamic import, so the keys cannot
 * live in the reader without dragging the reader (and `node:child_process`
 * with it) into every plugin load.
 *
 * The design record is the module doc of `./describe-resources.ts` and the
 * reader-facing version is `docs/pages/observation.mdx`. The short form:
 * chant elsewhere answers "is this mine?" from a marker it stamped onto the
 * live resource; terraform answers it from the state file, which already
 * records exactly which addresses a configuration manages. Nothing is ever
 * stamped, so nothing is ever written back over an estate's own tags.
 */

import type { ChannelKeys } from "@intentius/chant/ownership";

/**
 * Where the verdict is read from, rather than what is written.
 *
 * {@link ChannelKeys} names tag or label keys everywhere else, because
 * everywhere else the marker is a key/value pair on the resource. These three
 * name the state file, the configured root that owns that state, and the
 * workspace the root selects.
 */
export const TERRAFORM_STATE_OWNERSHIP_KEYS: ChannelKeys = {
  managedBy: "terraform.state",
  stack: "terraform.root",
  env: "terraform.workspace",
};
