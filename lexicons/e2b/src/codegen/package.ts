import { packagePipeline, collectSkills } from "@intentius/chant/codegen/package";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { LEXICON_ENTRIES } from "../catalog";
import { e2bPlugin } from "../plugin";

/**
 * Package the e2b lexicon: `dist/manifest.json`, `dist/meta.json`, the rules
 * and the skills. There is no generation step to run first; the registry is
 * the hand-written catalog in ../catalog.ts.
 */
export async function packageLexicon(options?: { verbose?: boolean; force?: boolean }) {
  const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const pkgJson = JSON.parse(readFileSync(join(srcDir, "..", "package.json"), "utf-8")) as { version?: string };

  return packagePipeline(
    {
      generate: async () => ({
        lexiconJSON: JSON.stringify(LEXICON_ENTRIES, null, 2),
        typesDTS: 'export * from "../index";\n',
        indexTS: "",
        resources: Object.values(LEXICON_ENTRIES).filter((e) => e.kind === "resource").length,
        properties: 0,
        enums: 0,
        warnings: [],
      }),
      buildManifest: () => ({
        name: "e2b",
        version: pkgJson.version ?? "0.0.0",
        chantVersion: ">=0.1.0",
        namespace: "E2B",
      }),
      srcDir,
      collectSkills: () => collectSkills(e2bPlugin.skills?.() ?? []),
    },
    options,
  );
}
