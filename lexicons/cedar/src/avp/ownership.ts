/**
 * The ownership channel for Amazon Verified Permissions (#1652).
 *
 * AVP is the one target in chant where the obvious channel does not exist. A
 * policy *store* is taggable — `TagResource` takes the same key/value map every
 * other AWS resource does. An individual policy is not: `CreatePolicy` accepts
 * a policy store id, a definition, and a client token, and there is no tag
 * surface on it at all. So the store-level tags can say "this store is chant's"
 * and nothing native can say "this policy is chant's" — which is the granularity
 * `delete` needs, because a store holds policies from more than one source the
 * moment somebody uses the console.
 *
 * The one durable, writable, readable per-policy field AVP has is
 * `Definition.Static.Description`. That is the channel: chant's marker is
 * encoded into a trailing bracketed segment of the description, ahead of which
 * the author's own text is preserved. It is read back on `describeResources`
 * and on `exportResources`, which is exactly what `ownershipChannel.reads`
 * declares (chant #1348) — no third path claims a verdict it cannot resolve.
 *
 * See ./OWNERSHIP.md for the design record, including what this channel costs
 * and the two alternatives that were rejected.
 */

import type { ChannelKeys, OwnershipMarker } from "@intentius/chant/ownership";
import { classifyOwnership, hasOwnershipMarker, ownershipEntries } from "@intentius/chant/ownership";

/**
 * The marker keys, shared by both AVP channels.
 *
 * The same three names serve the store's tag map and the per-policy description
 * marker, because `ownershipChannel` declares one {@link ChannelKeys} and a
 * lexicon whose two channels disagreed on key names would be two conventions
 * wearing one declaration. AWS tag keys permit `:`, and the description
 * encoding below quotes its values, so neither channel constrains the other.
 */
export const AVP_OWNERSHIP_KEYS: ChannelKeys = {
  managedBy: "chant:managed-by",
  stack: "chant:stack",
  env: "chant:env",
};

/**
 * The Cedar policy id this AVP policy carries, recorded beside the marker.
 *
 * Deliberately *not* part of {@link AVP_OWNERSHIP_KEYS}: it is not an ownership
 * claim and `hasOwnershipMarker` must not consult it. It is here because
 * `ListPolicies` returns descriptions but not statements, so without it every
 * live policy needs a second `GetPolicy` round trip just to learn which chant
 * entity it belongs to.
 */
export const AVP_POLICY_ID_KEY = "chant:policy-id";

/**
 * AVP caps `Definition.Static.Description` at 150 characters.
 *
 * The marker is what makes a policy deletable, so when the author's own text
 * plus the marker exceed the cap, the *text* is truncated and the marker is
 * kept whole. Silently dropping the marker would turn an owned policy into a
 * foreign one, and a foreign policy is never deleted — the estate would grow
 * undeletable policies with no error anywhere.
 */
export const AVP_DESCRIPTION_MAX = 150;

/** What {@link decodeOwnershipDescription} recovers from a live description. */
export interface DecodedDescription {
  /** The author's own description, marker segment removed. */
  text: string;
  /** Marker entries, keyed by {@link AVP_OWNERSHIP_KEYS} names, for the core ownership helpers. */
  tags: Record<string, string>;
  /** The Cedar policy id the marker recorded, when it carried one. */
  policyId?: string;
  /** Whether a marker segment was present at all. */
  marked: boolean;
}

const MARKER_SEGMENT = /\s*\[(chant:[^\]]*)\]\s*$/;

/**
 * Encode the marker into a description.
 *
 * Values are percent-encoded, so a stack named `my stack` or an id holding a
 * `]` round-trips instead of corrupting the segment. Reversed by
 * {@link decodeOwnershipDescription}.
 */
export function encodeOwnershipDescription(
  text: string | undefined,
  marker: OwnershipMarker,
  policyId?: string,
): string {
  const entries = ownershipEntries(AVP_OWNERSHIP_KEYS, marker);
  if (policyId) entries[AVP_POLICY_ID_KEY] = policyId;

  const segment = `[${Object.entries(entries)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join(" ")}]`;

  const authored = (text ?? "").trim();
  if (authored.length === 0) return segment;

  // The marker survives; the prose is what gives way (see AVP_DESCRIPTION_MAX).
  const room = AVP_DESCRIPTION_MAX - segment.length - 1;
  if (room <= 0) return segment;
  return `${authored.slice(0, room).trimEnd()} ${segment}`;
}

/** Recover the author's text and chant's marker from a live description. */
export function decodeOwnershipDescription(description: string | undefined): DecodedDescription {
  if (!description) return { text: "", tags: {}, marked: false };

  const match = MARKER_SEGMENT.exec(description);
  if (!match) return { text: description.trim(), tags: {}, marked: false };

  const tags: Record<string, string> = {};
  for (const pair of match[1].split(/\s+/)) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    try {
      tags[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
    } catch {
      // A malformed escape is a corrupt marker, not a crash. The entry is
      // dropped, which at worst downgrades the verdict to `foreign` — and a
      // foreign policy is never deleted, so the failure direction is the safe
      // one.
      continue;
    }
  }

  const policyId = tags[AVP_POLICY_ID_KEY];
  return {
    text: description.slice(0, match.index).trim(),
    tags,
    ...(policyId ? { policyId } : {}),
    marked: true,
  };
}

/**
 * The per-policy verdict, read off a live description.
 *
 * Two-valued on purpose: this function is only ever called where the
 * description was actually read, and `unknown` is reserved for the paths that
 * could not read it at all (the contract in core's `ownership.ts`).
 */
export function ownershipFromDescription(description: string | undefined): "owned" | "foreign" {
  return classifyOwnership(decodeOwnershipDescription(description).tags, AVP_OWNERSHIP_KEYS);
}

/** True when a live description carries chant's marker. */
export function descriptionIsOwned(description: string | undefined): boolean {
  return hasOwnershipMarker(decodeOwnershipDescription(description).tags, AVP_OWNERSHIP_KEYS);
}

/**
 * The store-level verdict, read off a policy store's tag map.
 *
 * The coarse channel: it answers "is this store chant's" and says nothing about
 * any individual policy in it. Kept separate from
 * {@link ownershipFromDescription} so a caller cannot accidentally treat a
 * store's tags as a policy's marker — the mistake the whole design exists to
 * avoid.
 */
export function ownershipFromStoreTags(tags: Record<string, unknown> | undefined): "owned" | "foreign" {
  return classifyOwnership(tags, AVP_OWNERSHIP_KEYS);
}

/** The tag entries to stamp onto a policy store. */
export function storeOwnershipTags(marker: OwnershipMarker): Record<string, string> {
  return ownershipEntries(AVP_OWNERSHIP_KEYS, marker);
}
