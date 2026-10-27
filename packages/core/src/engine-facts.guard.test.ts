// Guard (#4527, ruled on #4520 Q1): engine facts are for people and for
// readers that show the graph, never for a decision. Nothing under a change
// set, the lifecycle or an Op names `EngineFacts` or imports
// ./engine-facts.ts, so a delete, a plan or a gate cannot start reading a
// fact without this test failing. `IRNode.ownership` and
// `ResourceMetadata.ownership` keep feeding the painters and the change set.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const coreSrc = dirname(fileURLToPath(import.meta.url));
const repo = resolve(coreSrc, "..", "..", "..");

/** What a decision path must not contain: the type's name, or an import of its module. */
const FORBIDDEN = [/\bEngineFacts\b/, /["'][^"']*\/engine-facts(?:\.ts|\.js)?["']/];

/** The offending lines of one file's text, as `line: text`. */
export function engineFactsUses(text: string): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (FORBIDDEN.some((re) => re.test(line))) hits.push(`${i + 1}: ${line.trim()}`);
  });
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(?:ts|mts|tsx|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}

/** Every source file on a decision path: core's change set, lifecycle and Ops, and each lexicon's Ops and change-set files. */
function decisionPathFiles(): string[] {
  const files = new Set<string>();
  for (const f of walk(join(coreSrc, "lifecycle"))) files.add(f);
  for (const f of walk(join(coreSrc, "op"))) files.add(f);
  for (const f of walk(coreSrc)) if (/(?:^|[\\/])change-set[^\\/]*$/.test(relative(coreSrc, f))) files.add(f);
  const lexicons = join(repo, "lexicons");
  for (const lexicon of readdirSync(lexicons)) {
    const src = join(lexicons, lexicon, "src");
    let isDir = false;
    try {
      isDir = statSync(src).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    for (const f of walk(src)) {
      const rel = relative(src, f);
      if (/^op[\\/]/.test(rel) || /(?:^|[\\/])change-set[^\\/]*$/.test(rel)) files.add(f);
    }
  }
  return [...files].sort();
}

describe("engine facts never reach a decision path (#4527)", () => {
  it("scans the change set, the lifecycle and the Ops", () => {
    const files = decisionPathFiles().map((f) => relative(repo, f));
    expect(files).toContain("packages/core/src/change-set.ts");
    expect(files).toContain("packages/core/src/lifecycle/change-set.ts");
    expect(files.some((f) => f.startsWith("packages/core/src/op/"))).toBe(true);
    expect(files.some((f) => /^lexicons\/[^/]+\/src\/op\//.test(f))).toBe(true);
  });

  it("no file there names EngineFacts or imports engine-facts", () => {
    const offenders: string[] = [];
    for (const file of decisionPathFiles()) {
      for (const hit of engineFactsUses(readFileSync(file, "utf-8"))) offenders.push(`${relative(repo, file)}:${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  it("catches a BREAK: an import of the type, of the module, or a use by name", () => {
    expect(engineFactsUses('import type { EngineFacts } from "../engine-facts";')).toHaveLength(1);
    expect(engineFactsUses('import * as f from "../engine-facts.ts";')).toHaveLength(1);
    expect(engineFactsUses("const x: import('../graph-ir').IRNode['facts'] = y as EngineFacts;")).toHaveLength(1);
    expect(engineFactsUses('import type { IRNode } from "../graph-ir";')).toEqual([]);
  });
});
