/**
 * What makes an unqualified resource one resource (#1416).
 *
 * Managed resources are stack-qualified (`${stack}::${id}`, #1162) and cannot
 * collide. Everything else — dependencies (#1273) and ambient resources (#1278)
 * — is keyed by physical id and merged across stacks, because the account's
 * default VPC route table is one resource however many stacks route through it.
 *
 * That is right for a resource that really is account-level, and wrong for a
 * regional one. A VPC, subnet or security group in `us-west-1` is a different
 * resource from one in `us-east-1`, and merging them by id drops all but the
 * first sighting.
 *
 * On AWS the difference is invisible: VPC, subnet and security-group ids are
 * globally unique, so keying by id and keying by (region, id) give the same
 * answer. It shows up against an emulator that reuses ids across regions
 * (lex00/floci#21), where a three-region estate's nine default subnets merged
 * to three and "how many subnets are empty" came back 2 instead of 8.
 *
 * The rule is deliberately not a table of regional kinds. A lexicon stamps a
 * region on a resource when region is part of that resource's identity — the
 * AWS lexicon does it in `stampRegion` for ambient resources and its own
 * property reads — and this reads that stamp back. A genuinely account-level
 * resource carries no region and keeps merging as it always did, which is why
 * dependencies (never stamped) are untouched by this.
 */

import type { ResourceMetadata } from "../lexicon";

/**
 * The region a resource records itself as being in, if it records one.
 *
 * Read from `attributes.region`, which is where a lexicon stamps it. Absent
 * means the resource is account-level, or the lexicon has no region to give —
 * both of which are read the same way, as "region is not part of this id".
 */
export function regionOf(meta: Pick<ResourceMetadata, "attributes">): string | undefined {
  const region = meta.attributes?.region;
  return typeof region === "string" && region.length > 0 ? region : undefined;
}

/**
 * The key an unqualified resource merges under.
 *
 * `${region}::${id}` for a resource that carries a region, matching the shape
 * stack qualification already uses, and the bare id for one that does not.
 *
 * Applied only where results from more than one region are actually merged —
 * `collectAmbient` across stacks, `replaySnapshots` across recorded stacks.
 * Recording one region's observation qualifies nothing, so a stored snapshot
 * keeps the keys it has always had and the first snapshot taken after this
 * lands does not diff as "every ambient resource replaced".
 *
 * Idempotent, so an id that already carries this region survives a second pass
 * unchanged rather than becoming `us-east-1::us-east-1::sg-1`.
 */
export function unqualifiedKey(id: string, meta: Pick<ResourceMetadata, "attributes">): string {
  const region = regionOf(meta);
  if (!region) return id;
  return id.startsWith(`${region}::`) ? id : `${region}::${id}`;
}
