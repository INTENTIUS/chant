import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { packagePipeline } from "@intentius/chant/codegen/package";
import { generate } from "./generate";

/**
 * This package's `src/` directory. `packagePipeline` scans it for the rule
 * files that go into `dist/rules/`, so it must be `src/` and not `src/codegen/`
 * (which is where `dirname(import.meta.url)` alone lands, and where
 * `lint/rules` does not exist). `lexicons/aws/src/codegen/package.ts` resolves
 * it the same way.
 */
const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** The published version, so the manifest cannot drift from package.json. */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(srcDir, "..", "package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Package the terraform lexicon for distribution.
 */
export async function packageLexicon(options?: { verbose?: boolean; force?: boolean }) {
  const version = packageVersion();

  const { spec, stats } = await packagePipeline(
    {
      generate: (opts) => generate({ verbose: opts?.verbose, force: opts?.force }),
      buildManifest: () => ({
        name: "terraform",
        version,
        chantVersion: ">=0.1.0",
        namespace: "Terraform",
      }),
      srcDir,
      collectSkills: () => new Map(),
      version,
    },
    options,
  );

  return { spec, stats };
}
