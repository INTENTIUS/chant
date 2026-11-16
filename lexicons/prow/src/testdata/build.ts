/**
 * Test helpers: import a job config the way `chant import` does, build what
 * it wrote with `chant build`'s build, and read back the job config text.
 * Each build runs in a temporary directory inside this package, which the
 * helper removes, so the generated source resolves the lexicon.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "@intentius/chant/build";
import { generateOrganizedFiles } from "@intentius/chant/cli/commands/import";
import { ProwJobConfigParser } from "../import/parser";
import { ProwJobConfigGenerator } from "../import/generator";
import { prowSerializer } from "../serializer";

export const TESTDATA = import.meta.dirname;

export function fixture(path: string): string {
  return readFileSync(join(TESTDATA, path), "utf-8");
}

/** Build TypeScript source files (name to content) and return the prow output. */
export async function buildSources(files: Record<string, string>): Promise<{ output: string; errors: string[] }> {
  const dir = mkdtempSync(join(TESTDATA, "..", "..", ".build-tmp-"));
  try {
    const src = join(dir, "src");
    mkdirSync(src);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(src, name), content);
    const result = await build(src, [prowSerializer]);
    return { output: String(result.outputs.get("prow") ?? ""), errors: result.errors.map((e) => e.message) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `chant import` of a job config: the generated main.ts. */
export function importSource(text: string): string {
  const { files } = generateOrganizedFiles(new ProwJobConfigParser().parse(text), new ProwJobConfigGenerator());
  if (files.length !== 1 || files[0].path !== "main.ts") throw new Error(`import wrote ${files.map((f) => f.path).join(", ")}`);
  return files[0].content;
}

/** Import a job config, then build the import. */
export async function roundTrip(text: string): Promise<{ output: string; source: string; errors: string[] }> {
  const source = importSource(text);
  const { output, errors } = await buildSources({ "main.ts": source });
  return { output, source, errors };
}
