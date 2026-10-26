#!/usr/bin/env tsx
/** `npm run bundle`: write the pulumi lexicon's dist/ bundle, manifest included (#4468). */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { writeBundleSpec } from "@intentius/chant/codegen/package";
import { packageLexicon } from "./codegen/package";

const srcDir = dirname(fileURLToPath(import.meta.url));
const { spec, stats } = await packageLexicon({ verbose: true });
const distDir = join(dirname(srcDir), "dist");
writeBundleSpec(spec, distDir);

console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
console.error(`dist/ written to ${distDir}`);
