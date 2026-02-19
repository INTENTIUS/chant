#!/usr/bin/env bun
/**
 * Build dist/ artifacts for lexicon-aws package.
 * Used by the Docker npm smoke test.
 */
import { packageLexicon } from "../lexicons/aws/src/codegen/package";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const pkgDir = join(import.meta.dir, "..", "lexicons", "aws");
const distDir = join(pkgDir, "dist");

const { spec, stats } = await packageLexicon({ verbose: true });

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
