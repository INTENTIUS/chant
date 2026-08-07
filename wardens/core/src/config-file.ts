/**
 * Governance config loading: read a YAML or JSON file and check the root
 * shape. The YAML parser is injected — the gitlab/forgejo wardens use the
 * `yaml` package, the github warden its own dependency-free subset parser —
 * so this module stays runtime-dependency-free.
 */

import { readFileSync } from "node:fs";

export interface LoadConfigOptions {
  /** Top-level key the config must carry as an object (`nodes`, `orgs`, …). */
  rootKey: string;
  /** Parser used for non-.json files. */
  parseYaml: (text: string) => unknown;
}

export function loadConfigFile<T>(path: string, opts: LoadConfigOptions): T {
  const text = readFileSync(path, "utf-8");
  const raw = path.toLowerCase().endsWith(".json") ? JSON.parse(text) : opts.parseYaml(text);
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof (raw as Record<string, unknown>)[opts.rootKey] !== "object"
  ) {
    throw new Error(`config must be an object with ${article(opts.rootKey)} \`${opts.rootKey}\` map`);
  }
  return raw as T;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}
