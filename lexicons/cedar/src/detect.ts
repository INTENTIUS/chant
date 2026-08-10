/**
 * Edge-safe template detection for cedar (#426, #1653).
 *
 * Two documents belong to this lexicon: the JSON policy-set envelope the
 * serializer writes, and `.cedar` policy text. The first is recognized by its
 * shape and then confirmed by `checkParsePolicySet`; the second only by asking
 * the module to split it.
 *
 * The shape test is strict on purpose. `chant import` walks every loaded
 * plugin's `detectTemplate` in turn, so a lexicon that answers `true` for
 * someone else's JSON steals the file. `staticPolicies`/`templates`/
 * `templateLinks` and nothing else is a document no other lexicon writes, and
 * a policy set with no policies in it is not claimed at all — `{}` parses
 * perfectly well as an empty Cedar policy set, and matching it would swallow
 * every empty JSON object in the repo.
 */

import { isPolicySetEnvelope } from "./import/parser";
import { parsesAsPolicySet, splitPolicySet } from "./spec/wasm";

/** Does the envelope actually carry a policy or a template? */
function hasContent(envelope: Record<string, unknown>): boolean {
  const count = (value: unknown): number => {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === "object") return Object.keys(value).length;
    if (typeof value === "string") return value.trim().length > 0 ? 1 : 0;
    return 0;
  };
  return count(envelope.staticPolicies) + count(envelope.templates) > 0;
}

/** Is this text a Cedar policy document with at least one policy in it? */
function isPolicyText(content: string): boolean {
  if (!content.trim()) return false;
  const parts = splitPolicySet(content);
  return parts.ok && parts.value.policies.length + parts.value.templates.length > 0;
}

export function detectTemplate(data: unknown): boolean {
  if (typeof data === "string") {
    const trimmed = data.trim();
    if (!trimmed) return false;

    // A string may still be the envelope — `chant import` hands the parsed
    // object around, but the audit discovery path passes raw file contents.
    if (trimmed.startsWith("{")) {
      try {
        return detectTemplate(JSON.parse(trimmed));
      } catch {
        return false;
      }
    }
    return isPolicyText(trimmed);
  }

  if (!isPolicySetEnvelope(data)) return false;
  if (!hasContent(data)) return false;
  return parsesAsPolicySet(data);
}
