/**
 * behold#1029: ownership markers read off a listed object's tags or labels,
 * in chant#4520's `EngineFacts.markers` shape with `source: "live"`.
 *
 * The key sets the lister knows (#1025 "What a cloud source can and cannot
 * say about engine facts"):
 *  - choudoufu: `tofu-estate` and `tofu-address`, the address escaped
 *    (choudoufu internal/live/markers/markers.go:40,43);
 *  - plunge: `plunge-stack` and `plunge-urn` (continued in `plunge-urn-2`
 *    to `-4`), plain on tags and digests on labels (chant#4520's
 *    `markerScheme` for plunge);
 *  - chant: the lexicons' `ChannelKeys` with managed-by `chant`
 *    (packages/core/src/ownership.ts; aws `chant:*`, azure `chant-*`, gcp
 *    `managed-by` and `chant-stack`, the shared label convention for
 *    Kubernetes).
 *
 * `markers` is one object, so an object carrying several engines' markers
 * reports the first found in that order. Every tag stays in `tags`, so
 * nothing is lost. A marker key is matched case-insensitively, because Azure
 * tag names are case-insensitive. The lister never derives ownership from a
 * marker: that is relative to an estate or stack it does not read.
 */

import type { MarkerFact } from "./types";

function lookup(tags: Record<string, string>, key: string): string | undefined {
  if (key in tags) return tags[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(tags)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

const CHANT_KEY_SETS: ReadonlyArray<{ managedBy: string; stack: string }> = [
  { managedBy: "chant:managed-by", stack: "chant:stack" },
  { managedBy: "chant-managed-by", stack: "chant-stack" },
  { managedBy: "managed-by", stack: "chant-stack" },
  { managedBy: "app.kubernetes.io/managed-by", stack: "chant.intentius.io/stack" },
];

/**
 * The marker fact for one object. `labels` says the values came from GCP or
 * Kubernetes labels, where plunge writes digests rather than plain values.
 */
export function readMarkers(tags: Record<string, string>, opts: { labels: boolean }): MarkerFact | undefined {
  const estate = lookup(tags, "tofu-estate");
  if (estate !== undefined) {
    const address = lookup(tags, "tofu-address");
    return { owner: estate, ...(address !== undefined ? { address } : {}), encoding: "escaped", source: "live" };
  }
  const stack = lookup(tags, "plunge-stack");
  if (stack !== undefined) {
    let urn = lookup(tags, "plunge-urn");
    if (urn !== undefined && !opts.labels) {
      for (let i = 2; i <= 4; i++) {
        const more = lookup(tags, `plunge-urn-${i}`);
        if (more === undefined) break;
        urn += more;
      }
    }
    return {
      owner: stack,
      ...(urn !== undefined ? { address: urn } : {}),
      encoding: opts.labels ? "digest" : "plain",
      source: "live",
    };
  }
  for (const keys of CHANT_KEY_SETS) {
    if (lookup(tags, keys.managedBy) === "chant") {
      const owner = lookup(tags, keys.stack);
      return { ...(owner !== undefined ? { owner } : {}), encoding: "plain", source: "live" };
    }
  }
  return undefined;
}
