#!/usr/bin/env tsx
import { packageLexicon } from "./codegen/package";
import { writeBundleSpec } from "@intentius/chant/codegen/package";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

const { spec, stats } = await packageLexicon({ verbose: true });

const distDir = join(pkgDir, "dist");
writeBundleSpec(spec, distDir);

console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
