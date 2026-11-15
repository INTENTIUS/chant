/**
 * WK8005: Hardcoded Secrets in Environment Variables
 *
 * Detects container environment variables with names suggesting sensitive
 * values (password, token, key, secret) that use hardcoded string values
 * instead of secretKeyRef or configMapKeyRef.
 *
 * Two shapes are not secrets and are skipped. A name that ends in _FILE, _PATH
 * or _DIR whose value is a path (AWS_WEB_IDENTITY_TOKEN_FILE pointing at a
 * projected token) names where a secret lives, not the secret. A name whose
 * only credential word is KEY, where KEY follows a structural qualifier
 * (LOG_MESSAGE_KEY, PARTITION_KEY, SORT_KEY), names a field, not a credential.
 * Everything else keeps matching: a name that also carries password, token or
 * secret, a KEY with any other prefix (API_KEY, STRIPE_KEY, KEY), and any
 * *_FILE name whose value is not path-shaped.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { docsToManifests, extractContainers, containerLocator, WORKLOAD_KINDS, nameOf } from "./k8s-helpers";

const SENSITIVE_NAME_PATTERN = /password|token|key|secret/i;
const STRONG_NAME_PATTERN = /password|token|secret/i;

/** Words that make a following KEY a data field name rather than a credential. */
const STRUCTURAL_KEY_QUALIFIERS = new Set([
  "message", "msg", "partition", "sort", "range", "hash", "primary", "foreign",
  "shard", "routing", "index", "cache", "group", "order", "label", "field",
  "timestamp", "level",
]);

const FILE_SUFFIX_PATTERN = /(?:^|[_-])(?:file|path|dir|directory|filepath)$/i;

function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/** True when KEY is the only credential word and each KEY follows a structural qualifier. */
function isStructuralKeyName(name: string): boolean {
  if (STRONG_NAME_PATTERN.test(name)) return false;
  const tokens = nameTokens(name);
  let sawKey = false;
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].includes("key")) continue;
    sawKey = true;
    if (tokens[i] !== "key" || i === 0 || !STRUCTURAL_KEY_QUALIFIERS.has(tokens[i - 1])) return false;
  }
  return sawKey;
}

/** Absolute, home or explicitly relative path made only of path characters. */
function isPathValue(value: string): boolean {
  return /^(?:\/|~\/|\.{1,2}\/)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/?$/.test(value) ||
    /^[A-Za-z]:[\\/][^\s]+$/.test(value);
}

function isFilePointer(name: string, value: string): boolean {
  return FILE_SUFFIX_PATTERN.test(name) && isPathValue(value);
}

export const wk8005: PostSynthCheck = {
  id: "WK8005",
  description: "Hardcoded secrets in env vars — sensitive environment variables should use secretKeyRef",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const manifest of docsToManifests(ctx)) {
      if (!manifest.kind || !WORKLOAD_KINDS.has(manifest.kind)) continue;

      const containers = extractContainers(manifest);
      const resourceName = nameOf(manifest, manifest.kind);

      for (const container of containers) {
        if (!Array.isArray(container.env)) continue;

        for (const envVar of container.env) {
          if (
            typeof envVar.name === "string" &&
            SENSITIVE_NAME_PATTERN.test(envVar.name) &&
            !isStructuralKeyName(envVar.name) &&
            envVar.value !== undefined &&
            envVar.value !== null &&
            typeof envVar.value === "string" &&
            envVar.value !== "" &&
            !envVar.valueFrom &&
            !isFilePointer(envVar.name, envVar.value)
          ) {
            diagnostics.push({
              checkId: "WK8005",
              severity: "error",
              message: `Container "${container.name ?? "(unnamed)"}" in ${manifest.kind} "${resourceName}" has hardcoded value for sensitive env var "${envVar.name}" — use secretKeyRef instead`,
              entity: resourceName,
              locator: containerLocator(manifest, container),
              lexicon: "k8s",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
