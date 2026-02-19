/**
 * AWS lexicon packaging — delegates to core packagePipeline
 * with AWS-specific manifest building and skill collection.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
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
 * Map intrinsic name to its CloudFormation output key.
 */
function intrinsicOutputKey(name: string): string {
  switch (name) {
    case "Ref": return "Ref";
    default: return `Fn::${name}`;
  }
}

/**
 * Package the AWS lexicon into a distributable BundleSpec.
 */
export async function packageLexicon(opts: PackageOptions = {}): Promise<PackageResult> {
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "..", "package.json"), "utf-8"));

  return packagePipeline(
    {
      generate: (genOpts) => generate({ verbose: genOpts.verbose, force: genOpts.force }),

      buildManifest: (_genResult) => {
        // Lazy-import to avoid circular dependency
        const { awsPlugin } = require("../plugin");

        const intrinsics: IntrinsicDef[] = (awsPlugin.intrinsics?.() ?? []).map(
          (i: { name: string; description: string }) => ({
            name: i.name,
            description: i.description,
            outputKey: intrinsicOutputKey(i.name),
            isTag: i.name === "Sub",
          }),
        );

        const pseudoParams: string[] = awsPlugin.pseudoParameters?.() ?? [];
        const pseudoParameters: Record<string, string> = {};
        for (const p of pseudoParams) {
          const shortName = p.split("::").pop()!;
          pseudoParameters[shortName] = p;
        }

        return {
          name: "aws",
          version: pkgJson.version ?? "0.0.0",
          chantVersion: ">=0.1.0",
          namespace: "AWS",
          intrinsics,
          pseudoParameters,
        };
      },

      srcDir: pkgDir,

      collectSkills: () => {
        const { awsPlugin } = require("../plugin");
        const skillDefs = awsPlugin.skills?.() ?? [];
        return collectSkills(skillDefs);
      },

      version: pkgJson.version ?? "0.0.0",
    },
    opts,
  );
}
