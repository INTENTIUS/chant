/**
 * Azure lexicon packaging — delegates to core packagePipeline
 * with Azure-specific manifest building and skill collection.
 */

import { readFileSync } from "fs";
import { azurePlugin } from "../plugin";
import { dirname } from "path";
import { fileURLToPath } from "url";
import type { IntrinsicDef } from "@intentius/chant/lexicon";
import {
  packagePipeline,
  collectSkills,
  type PackageOptions,
  type PackageResult,
} from "@intentius/chant/codegen/package";
import { generate } from "./generate";

export type { PackageOptions, PackageResult };

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Map intrinsic name to its ARM output key.
 */
function intrinsicOutputKey(name: string): string {
  return name;
}

/**
 * Package the Azure lexicon into a distributable BundleSpec.
 */
export async function packageLexicon(opts: PackageOptions = {}): Promise<PackageResult> {
  const pkgJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));

  return packagePipeline(
    {
      generate: (genOpts) => generate({ verbose: genOpts.verbose, force: genOpts.force }),

      buildManifest: (_genResult) => {
        // Lazy-import to avoid circular dependency
        // Trust the plugin's own `isTag` registration (chant #1067) instead
        // of hardcoding `false` for every entry regardless of what
        // ../plugin.ts declares — see aws's codegen/package.ts for the bug
        // this pattern produced (#1039) when the two sources disagree.
        const intrinsics: IntrinsicDef[] = (azurePlugin.intrinsics?.() ?? []).map(
          (i: IntrinsicDef) => ({
            name: i.name,
            description: i.description,
            outputKey: intrinsicOutputKey(i.name),
            isTag: i.isTag,
            // chant #1044 — carried through verbatim for the same reason as
            // `isTag`: the packaged manifest is what a consumer reads to
            // learn which intrinsics fold, so recomputing it here would be a
            // second source of truth able to drift from ../plugin.ts.
            foldsAsCall: i.foldsAsCall,
          }),
        );

        const pseudoParams: string[] = azurePlugin.pseudoParameters?.() ?? [];
        const pseudoParameters: Record<string, string> = {};
        for (const p of pseudoParams) {
          const shortName = p.split(".").pop()!;
          pseudoParameters[shortName] = p;
        }

        return {
          name: "azure",
          version: pkgJson.version ?? "0.0.0",
          chantVersion: ">=0.1.0",
          namespace: "Azure",
          intrinsics,
          pseudoParameters,
        };
      },

      srcDir: pkgDir,

      collectSkills: () => {        const skillDefs = azurePlugin.skills?.() ?? [];
        return collectSkills(skillDefs);
      },

      version: pkgJson.version ?? "0.0.0",
    },
    opts,
  );
}
