/**
 * WGL016: Secrets in Variables
 *
 * Detects hardcoded passwords, tokens, or secrets in `variables:` blocks.
 * These should use CI/CD masked variables instead.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput } from "./yaml-helpers";

const SECRET_PATTERNS = [
  /password\s*[:=]\s*['"]?[^\s'"]+/i,
  /secret\s*[:=]\s*['"]?[^\s'"]+/i,
  /token\s*[:=]\s*['"]?[^\s'"]+/i,
  /api[_-]?key\s*[:=]\s*['"]?[^\s'"]+/i,
  /private[_-]?key\s*[:=]\s*['"]?[^\s'"]+/i,
];

/** Variable name patterns that indicate credentials. */
const SECRET_VAR_NAMES = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /credentials?/i,
];

/** Values that are clearly references (not hardcoded secrets). */
function isReference(value: string): boolean {
  return value.startsWith("$") || value.startsWith("${");
}

export function checkSecretsInVariables(yaml: string): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  // Extract variables blocks (global and per-job)
  const varBlocks = yaml.matchAll(/^(\s*)variables:\n((?:\1\s+.+\n?)+)/gm);

  for (const block of varBlocks) {
    const lines = block[2].split("\n");
    for (const line of lines) {
      const kv = line.match(/^\s+(\w+):\s+(.+)$/);
      if (!kv) continue;

      const [, varName, rawValue] = kv;
      const value = rawValue.trim().replace(/^['"]|['"]$/g, "");

      if (isReference(value)) continue;

      // Check if variable name suggests a secret
      for (const pattern of SECRET_VAR_NAMES) {
        if (pattern.test(varName)) {
          diagnostics.push({
            checkId: "WGL016",
            severity: "error",
            message: `Variable "${varName}" appears to contain a hardcoded secret — use a CI/CD masked variable instead`,
            entity: varName,
            lexicon: "gitlab",
          });
          break;
        }
      }
    }
  }

  return diagnostics;
}

export const wgl016: PostSynthCheck = {
  id: "WGL016",
  description: "Secrets in variables — hardcoded passwords or tokens in variables blocks",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      diagnostics.push(...checkSecretsInVariables(yaml));
    }
    return diagnostics;
  },
};
