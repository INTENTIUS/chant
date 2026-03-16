/**
 * WHM103: Go template syntax valid (balanced braces, valid function names).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles, hasBalancedBraces } from "./helm-helpers";

const VALID_FUNCTIONS = new Set([
  // Built-in Go template functions
  "if", "else", "end", "range", "with", "define", "template", "block",
  // Helm/Sprig functions
  "include", "required", "default", "toYaml", "toJson", "fromYaml", "fromJson",
  "quote", "squote", "upper", "lower", "title", "trim", "trimSuffix", "trimPrefix",
  "printf", "print", "println", "tpl", "lookup",
  "nindent", "indent", "replace", "contains", "hasPrefix", "hasSuffix",
  "repeat", "substr", "trunc", "abbrev", "randAlphaNum", "randAlpha",
  "b64enc", "b64dec", "sha256sum", "now", "date",
  "list", "dict", "get", "set", "unset", "hasKey", "pluck", "keys", "values",
  "append", "prepend", "first", "last", "uniq", "without", "has",
  "empty", "coalesce", "ternary", "cat", "join", "split", "splitList",
  "toStrings", "toString", "int", "int64", "float64", "atoi",
  "add", "sub", "mul", "div", "mod", "max", "min", "ceil", "floor", "round",
  "and", "or", "not", "eq", "ne", "lt", "le", "gt", "ge",
  "typeOf", "kindOf", "typeIs", "kindIs", "deepEqual",
  "semver", "semverCompare",
  "regexMatch", "regexFind", "regexReplaceAll",
  "sha1sum", "derivePassword", "genPrivateKey", "buildCustomCert", "genCA", "genSignedCert",
  "env", "expandenv",
  "fail",
]);

export const whm103: PostSynthCheck = {
  id: "WHM103",
  description: "Go template syntax must be valid (balanced braces)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);

      for (const [filename, content] of Object.entries(files)) {
        if (!filename.startsWith("templates/")) continue;

        if (!hasBalancedBraces(content)) {
          diagnostics.push({
            checkId: "WHM103",
            severity: "error",
            message: `Unbalanced template braces in ${filename}`,
            entity: filename,
            lexicon: "helm",
          });
        }
      }
    }

    return diagnostics;
  },
};
