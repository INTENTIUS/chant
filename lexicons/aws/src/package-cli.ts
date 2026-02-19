#!/usr/bin/env bun
/**
 * Thin entry point for `bun run bundle` in lexicon-aws.
 * Generates src/generated/ files and writes dist/ bundle.
 *
 * NOTE: Does NOT call plugin.package() because that internally spawns
 * `bun pm pack`, which would cause infinite recursion when invoked
 * from a prepack lifecycle script.
 */
import { generate, writeGeneratedFiles } from "./codegen/generate";
import { packageLexicon } from "./codegen/package";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

// 1. Generate src/generated/ files
const genResult = await generate({ verbose: true });
writeGeneratedFiles(genResult, pkgDir);
console.error(`Generated ${genResult.resources} resources, ${genResult.properties} property types, ${genResult.enums} enums`);

// 2. Run package pipeline and write dist/
const { spec, stats } = await packageLexicon({ verbose: true });

const distDir = join(pkgDir, "dist");
mkdirSync(join(distDir, "types"), { recursive: true });
mkdirSync(join(distDir, "rules"), { recursive: true });
mkdirSync(join(distDir, "skills"), { recursive: true });

writeFileSync(join(distDir, "manifest.json"), JSON.stringify(spec.manifest, null, 2));
writeFileSync(join(distDir, "meta.json"), spec.registry);
writeFileSync(join(distDir, "types", "index.d.ts"), spec.typesDTS);

for (const [name, content] of spec.rules) {
  writeFileSync(join(distDir, "rules", name), content);
}
for (const [name, content] of spec.skills) {
  writeFileSync(join(distDir, "skills", name), content);
}

if (spec.integrity) {
  writeFileSync(join(distDir, "integrity.json"), JSON.stringify(spec.integrity, null, 2));
}

console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
console.error(`dist/ written to ${distDir}`);
