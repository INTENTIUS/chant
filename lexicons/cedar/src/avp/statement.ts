/**
 * The two text-level facts the observation needs from a live Cedar statement
 * (#1652): which `@id` it carries — the link back to a chant entity — and
 * whether it permits or forbids.
 *
 * Both by regex, with no parser behind them, and that is the point. Reading a
 * policy *properly* is `src/import/parser.ts`'s job and it goes through
 * `cedar-wasm`, which is a 12 MB module; the observation path must not load it,
 * because `plugin.ts` imports `ambientKinds()` eagerly and every `chant`
 * invocation would pay for it. Live export, which is allowed to be slow and
 * needs real fidelity, uses the import parser instead of anything here.
 *
 * Neither function is a judgement. `observeAmbient` reports the effect and
 * stops; whether an ambient `permit` is a standing grant worth acting on is the
 * consumer's call.
 */

import type { CedarEffect } from "../serializer";

/** The `@id("…")` a chant-emitted statement always carries, or undefined. */
export function policyIdFromStatement(statement: string): string | undefined {
  const match = /@id\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/.exec(statement);
  if (!match) return undefined;
  return unescapeCedarString(match[1]);
}

/** `permit` or `forbid`, scanned past any annotations. */
export function effectFromStatement(statement: string): CedarEffect | undefined {
  const match = /(?:^|\n)\s*(permit|forbid)\s*\(/.exec(stripAnnotations(statement));
  return match ? (match[1] as CedarEffect) : undefined;
}

function stripAnnotations(statement: string): string {
  return `\n${statement.replace(/@[A-Za-z_][A-Za-z0-9_]*\s*\(\s*"(?:[^"\\]|\\.)*"\s*\)/g, "\n")}`;
}

function unescapeCedarString(value: string): string {
  return value.replace(/\\(.)/g, (_, ch: string) => {
    switch (ch) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return ch;
    }
  });
}
