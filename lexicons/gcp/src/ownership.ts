/**
 * GCP's ownership marker channels (#1446).
 *
 * The gcp lexicon marks ownership on **two different surfaces**, and they
 * legitimately use different key vocabularies:
 *
 * 1. **The Config Connector object** — what the serializer emits. Its
 *    `metadata.labels` are Kubernetes labels, so it uses core's shared
 *    `LABEL_OWNERSHIP_KEYS` (`app.kubernetes.io/managed-by`). That is the key
 *    `plugin.ts` registers as the lexicon's `ownershipChannel` and the one the
 *    read paths resolve through.
 *
 * 2. **The GCP resource itself** — what `gcpApply` PUTs to the REST API. GCP
 *    label keys may not contain `/` or `.`, so `app.kubernetes.io/managed-by`
 *    is not a legal key there. Hence {@link GCP_RESOURCE_OWNERSHIP_KEYS}.
 *
 * This is worth stating because the split looks like the bug #1446 found in the
 * azure applier, and is not. Azure's serializer and applier both write ARM tags
 * — one surface, and they had drifted onto two keys for no reason. Here the two
 * surfaces are real and each key is the only legal one for its target.
 *
 * What #1446 changes is that the applier's predicate resolves through core's
 * `hasOwnershipMarker` against a declared channel, rather than comparing a
 * string literal inline. The key does not move; the drift risk does.
 */

import { readOwnership, LABEL_OWNERSHIP_KEYS, OWNERSHIP_MANAGED_BY_VALUE, type ChannelKeys } from "@intentius/chant/ownership";

/**
 * Ownership keys for labels on a live GCP resource — the surface `gcpApply`
 * writes and `pruneOrphans` reads.
 *
 * GCP label keys are lowercase alphanumerics, `-` and `_` only, so this is the
 * GCP-valid equivalent of core's label convention rather than that convention
 * itself.
 */
export const GCP_RESOURCE_OWNERSHIP_KEYS: ChannelKeys = {
  managedBy: "managed-by",
  stack: "chant-stack",
  env: "chant-env",
};

/**
 * Coerce a stack or env name into a legal GCP label value: lowercase letters,
 * digits, `_` and `-`, at most 63 characters. Anything else becomes `-`.
 * Returns `undefined` when nothing usable is left. Stamping and reading both go
 * through this, so `describeStackStatus` matches what `gcpApply` wrote.
 */
export function gcpLabelValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 63);
  return v.length > 0 ? v : undefined;
}

const GCP_LABEL_KEY = /^[a-z][a-z0-9_-]{0,62}$/;
const GCP_LABEL_VALUE = /^[a-z0-9_-]{0,63}$/;

/**
 * The manifest labels GCP will accept as-is: keys already legal for GCP
 * (lowercase, start with a letter, `[a-z0-9_-]`, at most 63 chars), values
 * that already fit `[a-z0-9_-]{0,63}`. Entries that do not fit are dropped, not
 * rewritten (ownership values are coerced, see {@link chantOwnershipLabels}). Keys that cannot be represented
 * (`app.kubernetes.io/*`, `chant.intentius.io/*`, anything with `/` or `.`) are
 * dropped, not renamed: a mangled key could collide with another and has no
 * meaning to anything that reads it back. Chant's own ownership labels are the
 * exception, see {@link chantOwnershipLabels}.
 */
export function gcpPassThroughLabels(labels: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels ?? {})) {
    if (GCP_LABEL_KEY.test(k) && typeof v === "string" && GCP_LABEL_VALUE.test(v)) out[k] = v;
  }
  return out;
}

/**
 * The GCP labels chant stamps on resources it creates: `managed-by`, plus the
 * `chant-stack` and `chant-env` labels `describeStackStatus` reads (#3143).
 *
 * The stack and env come from the serialized Config Connector object's own
 * ownership labels (`chant.intentius.io/stack|env`, stamped by the serializer
 * from project config), the way the aws applier takes its stack tags from the
 * template's marker. Values are coerced to GCP label rules. A manifest that
 * already carries a GCP-style `chant-stack` / `chant-env` keeps it. With no
 * marker on the object, only `managed-by` is stamped.
 */
export function chantOwnershipLabels(
  manifestLabels?: Record<string, unknown> | null,
): Record<string, string> {
  const out: Record<string, string> = { [GCP_RESOURCE_OWNERSHIP_KEYS.managedBy]: OWNERSHIP_MANAGED_BY_VALUE };
  const marker = manifestLabels ? readOwnership(manifestLabels, LABEL_OWNERSHIP_KEYS) : undefined;
  const pick = (gcpKey: string, fallback: string | undefined): string | undefined => {
    const own = manifestLabels?.[gcpKey];
    return gcpLabelValue(typeof own === "string" && own ? own : fallback);
  };
  const stack = pick(GCP_RESOURCE_OWNERSHIP_KEYS.stack, marker?.stack);
  const env = pick(GCP_RESOURCE_OWNERSHIP_KEYS.env, marker?.env);
  if (stack) out[GCP_RESOURCE_OWNERSHIP_KEYS.stack] = stack;
  if (env) out[GCP_RESOURCE_OWNERSHIP_KEYS.env] = env;
  return out;
}

/**
 * Every label the gcp lexicon sends to a GCP API for a manifest: the legal
 * manifest labels plus chant's ownership labels in their GCP forms. The one
 * place manifest labels are mapped; request bodies must not use
 * `metadata.labels` directly.
 */
export function gcpResourceLabels(labels: Record<string, unknown> | null | undefined): Record<string, string> {
  return { ...gcpPassThroughLabels(labels), ...chantOwnershipLabels(labels) };
}
