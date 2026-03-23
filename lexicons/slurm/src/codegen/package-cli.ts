#!/usr/bin/env bun
/**
 * CLI entry point for `bun run package` in lexicon-slurm.
 */
import { packageLexicon } from "./package";
import { writeBundleSpec } from "@intentius/chant/codegen/package";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const { spec, stats } = await packageLexicon({ verbose: true });
writeBundleSpec(spec, join(pkgDir, "dist"));

console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
