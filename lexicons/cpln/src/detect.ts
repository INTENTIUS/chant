/**
 * Detect whether a template is a Control Plane manifest.
 *
 * cpln manifests are structurally light — `kind`, `name`, and usually `spec` —
 * which is not a lot to go on, and `kind`/`name`/`spec` alone would also match a
 * Kubernetes manifest. The discriminator is that a cpln manifest's `kind` is one
 * of a small closed set of lowercase strings and it has **no `apiVersion`**,
 * which every Kubernetes object has and no cpln manifest does.
 */

import { KIND_NAMES } from "./kinds";

const KINDS = new Set(KIND_NAMES);

/**
 * Every kind `cpln apply` accepts, not only the ones this lexicon models — a
 * file of `group` and `serviceaccount` documents is still recognisably a
 * Control Plane manifest, and answering "no" to it would be wrong.
 */
const ALL_CPLN_KINDS = new Set([
  ...KIND_NAMES,
  "agent",
  "auditctx",
  "cloudaccount",
  "group",
  "image",
  "location",
  "mk8s",
  "org",
  "quota",
  "serviceaccount",
  "user",
]);

/** True when `data` is a cpln manifest document, or a list of them. */
export function detectCplnTemplate(data: unknown): boolean {
  if (Array.isArray(data)) {
    return data.length > 0 && data.every((doc) => detectCplnTemplate(doc));
  }

  if (!data || typeof data !== "object") return false;
  const doc = data as Record<string, unknown>;

  // A Kubernetes object. Same three keys, different platform.
  if (typeof doc.apiVersion === "string") return false;

  const kind = doc.kind;
  if (typeof kind !== "string" || !ALL_CPLN_KINDS.has(kind)) return false;

  // `name` is the one field every cpln manifest carries. A bare `{ kind }` is
  // more likely a fragment than a manifest.
  return typeof doc.name === "string";
}

/** True when the document is a kind this lexicon can generate types for. */
export function isModelledKind(kind: string): boolean {
  return KINDS.has(kind);
}
