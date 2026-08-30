/**
 * `chant cedar <verb>` — the consumer-facing surface over this lexicon's
 * codegen (#1696), mounted through the command-group seam (#1078).
 *
 * `chant dev generate` exists, but it is lexicon development: it runs every
 * configured lexicon's generate, validate and coverage in turn, and for a
 * project that also lists `aws` that means fetching the CloudFormation spec.
 * A consumer regenerating its own Cedar classes after a schema edit wants one
 * lexicon, one step, and an output path it can see.
 */

import type { CommandGroup, CommandGroupContext } from "@intentius/chant/cli/command-group";
import { splitJoinedFlags, unknownFlagError } from "@intentius/chant/cli/command-group";

interface ParsedFlags {
  outDir?: string;
  verbose: boolean;
  minOverall?: number;
}

function parseFlags(verb: string, raw: string[], accept: ReadonlySet<string>): ParsedFlags {
  const args = splitJoinedFlags(raw, new Set(["--verbose", "-v"]));
  const flags: ParsedFlags = { verbose: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "--verbose" || a === "-v") && accept.has("--verbose")) {
      flags.verbose = true;
    } else if (a === "--out-dir" && accept.has("--out-dir")) {
      const value = args[++i];
      if (!value) throw new Error(`--out-dir needs a directory.`);
      flags.outDir = value;
    } else if (a === "--min-overall" && accept.has("--min-overall")) {
      const value = Number(args[++i]);
      if (!Number.isFinite(value)) throw new Error(`--min-overall needs a number.`);
      flags.minOverall = value;
    } else {
      const hint = `"chant cedar ${verb}" accepts ${[...accept].join(", ")}.`;
      throw unknownFlagError(a, hint);
    }
  }
  return flags;
}

async function generateHandler(ctx: CommandGroupContext): Promise<number> {
  const flags = parseFlags("generate", ctx.rawArgs, new Set(["--out-dir", "--verbose"]));
  const { generate, resolveGeneratedDir, writeGeneratedFiles } = await import("./codegen/generate");
  const { loadCedarProject } = await import("./config");

  const project = await loadCedarProject(process.cwd());
  // A flag beats the config, and both beat the default — the same order
  // `cedar.schema` follows one level down.
  const config = flags.outDir ? { ...project.config, outDir: flags.outDir } : project.config;
  const result = await generate({ verbose: flags.verbose, projectRoot: project.projectRoot, config });
  const outDir = resolveGeneratedDir({ projectRoot: project.projectRoot, config });
  writeGeneratedFiles(result, outDir);
  console.error(`cedar: generated ${result.resources} declaration(s) into ${outDir}`);
  return 0;
}

async function coverageHandler(ctx: CommandGroupContext): Promise<number> {
  const flags = parseFlags("coverage", ctx.rawArgs, new Set(["--min-overall", "--verbose"]));
  const { analyzeCedarCoverage } = await import("./coverage");
  const { resolveGeneratedDir } = await import("./codegen/generate");
  const { loadCedarProject } = await import("./config");

  const { projectRoot, config } = await loadCedarProject(process.cwd());
  analyzeCedarCoverage({
    projectRoot,
    config,
    generatedDir: resolveGeneratedDir({ projectRoot, config }),
    verbose: flags.verbose,
    minOverall: flags.minOverall,
  });
  return 0;
}

/** The `chant cedar` verb group. */
export function cedarCommandGroup(): CommandGroup {
  return {
    name: "cedar",
    description: "Schema-driven codegen for a project's Cedar policies: generate typed classes into the project, check schema coverage",
    commands: [
      {
        name: "generate",
        description: "Read the project's .cedarschema and write typed classes into cedar.outDir (default src/generated/cedar)",
        handler: generateHandler,
      },
      {
        name: "coverage",
        description: "Report which schema declarations the generated classes cover",
        handler: coverageHandler,
      },
    ],
  };
}
