#!/usr/bin/env tsx
/**
 * `npm run bundle` for the e2b lexicon: writes dist/manifest.json, dist/meta.json,
 * the rules and the skills.
 */
import { packageLexicon } from "./codegen/package";
import { writeBundleSpec } from "@intentius/chant/codegen/package";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const verbose = process.argv.includes("--verbose");

const { spec, stats } = await packageLexicon({ verbose });
writeBundleSpec(spec, distDir);
console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules, ${stats.skillCount} skills into ${distDir}`);
