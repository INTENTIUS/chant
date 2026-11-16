/**
 * The generated registry (generated/lexicon-prow.json), read from beside
 * this module: src/ in a checkout, dist/ in the published package.
 */
import { createRequire } from "module";
import { moduleSourceUrl } from "@intentius/chant/module-source";

const require = createRequire(moduleSourceUrl(import.meta.url));

let names: string[] | undefined;

/** The class names of the property entities: the pod spec and every other value nested in a job. */
export function propertyEntityNames(): string[] {
  names ??= Object.entries(require("./generated/lexicon-prow.json") as Record<string, { kind: string }>)
    .filter(([, e]) => e.kind === "property")
    .map(([name]) => name);
  return names;
}
