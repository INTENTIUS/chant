import type { LexiconPlugin } from "../lexicon";
import type { ParserOptions, ParserOptionSpec } from "./parser";

/**
 * Check `--parser-option` entries (`key` or `key=value`) against what the
 * lexicon declares in `parserOptions()` and convert each value to its declared
 * type (#2994). Returns the options, or an error message naming what is wrong
 * and what the lexicon accepts. An empty list is always valid.
 */
export function resolveParserOptions(
  plugin: Pick<LexiconPlugin, "name" | "parserOptions">,
  entries: readonly string[] | undefined,
): { options: ParserOptions } | { error: string } {
  const options: ParserOptions = {};
  if (!entries || entries.length === 0) return { options };

  const specs: ParserOptionSpec[] = plugin.parserOptions?.() ?? [];
  const accepted =
    specs.length === 0
      ? `lexicon "${plugin.name}" declares no parser options`
      : `${plugin.name} accepts: ${specs.map((s) => `${s.name} (${s.type}): ${s.description}`).join("; ")}`;

  for (const entry of entries) {
    const eq = entry.indexOf("=");
    const name = eq === -1 ? entry : entry.slice(0, eq);
    const raw = eq === -1 ? undefined : entry.slice(eq + 1);
    const spec = specs.find((s) => s.name === name);
    if (!spec) {
      return { error: `Unknown parser option "${name}" for lexicon "${plugin.name}"; ${accepted}.` };
    }
    if (spec.type === "boolean") {
      if (raw === undefined || raw === "true") options[name] = true;
      else if (raw === "false") options[name] = false;
      else return { error: `Parser option "${name}" is a boolean: use ${name}, ${name}=true or ${name}=false, got "${raw}".` };
    } else if (raw === undefined) {
      return { error: `Parser option "${name}" needs a value: --parser-option ${name}=<${spec.type}>.` };
    } else if (spec.type === "number") {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n)) return { error: `Parser option "${name}" is a number, got "${raw}".` };
      options[name] = n;
    } else {
      options[name] = raw;
    }
  }
  return { options };
}
