/**
 * The live root's ownership channel (#2104): choudoufu's two marker tags.
 *
 * Sibling of `./state-ownership.ts`, and here for the same mechanical reason:
 * `plugin.ts` declares `ownershipChannel` eagerly while `describeResources`
 * is behind a dynamic import, so the key names cannot live in the reader
 * without dragging the reader, and `node:child_process` with it, into every
 * plugin load.
 *
 * ## Why the keys are declared and the verdicts are set by hand
 *
 * The issue that added this asked which of two ways to go: widen core's
 * `OwnershipChannel` so a lexicon can supply its own classifier, or declare
 * the keys for discoverability and set the verdicts in the reader, the way
 * `lexicons/fly/src/ownership.ts` does for its two tiers. The second, and the
 * reason is that the first buys nothing.
 *
 * Core's `classifyOwnership` tests one thing: does `tags[keys.managedBy]`
 * equal the literal `"chant"`. Nothing in core ever calls it on a lexicon's
 * behalf. `packages/core/src/ownership.ts` exports it, every lexicon calls it
 * itself where the test happens to fit, and the ones it does not fit, fly's
 * app boundary and aws's stack tags, already set verdicts directly. Adding a
 * `classify` member to `OwnershipChannel` would give core a field only this
 * lexicon passes and only this lexicon reads back, which is a longer way of
 * writing the function `./describe-resources.ts` already has.
 *
 * What the declaration is still for is the claim it makes. Declaring
 * `describeResources` on the channel is what turns the observation
 * conformance suite's ownership assertion from a shape check into a
 * behavioural one, and that claim holds on a live root exactly as it does on
 * a stock one, from a different reading. The suite runs for both modes in
 * `./describe-resources.test.ts`.
 *
 * ## The keys, and the slot that does not fit
 *
 * `ChannelKeys` is a managed-by / stack / env triple, because everywhere else
 * chant stamps three tags. choudoufu's marker is two tags and no managed-by
 * key at all: per `live/MARKERS.md`'s "Ownership semantics", a resource
 * carrying `tofu-estate` belongs to that estate and there is no secondary
 * check, so `tofu-estate` is both the managed-by claim and the stack
 * identity. `tofu-address` takes the third slot because it is the marker's
 * other half, not because it is an environment: a choudoufu marker has no
 * environment in it, which is why `ResourceMetadata.marker` on a live read
 * carries the estate as its `stack` and leaves `env` absent rather than
 * filling it with an address.
 */

import type { ChannelKeys } from "@intentius/chant/ownership";

/**
 * The two tag keys `live/MARKERS.md` spec version 1 defines, named here so a
 * reader of the plugin can see what a live root's verdict is read from.
 * `./hcl/marker.ts` holds the constants the reader itself uses, along with
 * the escaping and the ownership semantics that go with them.
 */
export const TERRAFORM_LIVE_MARKER_KEYS: ChannelKeys = {
  managedBy: "tofu-estate",
  stack: "tofu-estate",
  env: "tofu-address",
};
