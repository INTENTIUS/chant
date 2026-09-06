import { createRequire } from "module";
import { LexiconIndex, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";

const require = createRequire(import.meta.url);

/** A fountain registry entry, with the full authored prop list generate writes. */
interface FountainEntry extends LexiconEntry {
  props?: string[];
}

/**
 * The fountain lexicon index.
 *
 * Core's `LexiconIndex` reads prop names off `propertyConstraints`, which
 * carries a prop only when upstream constrained it. That is fine for a
 * CloudFormation-shaped lexicon and lossy for this one: `Schedule.cron` and
 * `Webhook.url` are documented with an example rather than a pattern, so the
 * two props most worth completing would be the two missing from completion.
 * The generator writes the full list as `props`; this merges it in.
 */
class FountainLexiconIndex extends LexiconIndex {
  constructor(private readonly data: Record<string, FountainEntry>) {
    super(data);
  }

  override getPropertyNames(className: string): string[] {
    const entry = this.data[className];
    if (!entry || entry.kind !== "resource") return [];
    const names = [...(entry.props ?? [])];
    for (const name of super.getPropertyNames(className)) {
      if (!names.includes(name)) names.push(name);
    }
    return names;
  }
}

let cached: LexiconIndex | null = null;

/** The shared index behind completions and hover. */
export function fountainLexiconIndex(): LexiconIndex {
  if (cached) return cached;
  const data = require("../generated/lexicon-fountain.json") as Record<string, FountainEntry>;
  cached = new FountainLexiconIndex(data);
  return cached;
}
