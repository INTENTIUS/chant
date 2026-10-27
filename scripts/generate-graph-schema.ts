#!/usr/bin/env tsx
/**
 * Write the graph JSON Schema set and its fixtures from chant core's types
 * (#4527): packages/core/src/graph-schema/graph.schema.json and
 * packages/core/src/graph-schema/fixtures/*.json. See
 * packages/core/src/graph-schema/generate.ts.
 *
 *   npm run generate:graph-schema              write the files
 *   npm run generate:graph-schema -- --check   exit 1 when a checked-in file is stale
 */
import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import { generatedGraphSchemaFiles, staleGraphSchemaFiles } from "@intentius/chant/graph-schema/generate";

const root = process.cwd();
if (process.argv.includes("--check")) {
  const stale = staleGraphSchemaFiles();
  if (stale.length > 0) {
    for (const path of stale) console.error(`  stale: ${relative(root, path)}`);
    console.error("The graph schema is out of date with the TypeScript types. Run `npm run generate:graph-schema` and commit the result.");
    process.exit(1);
  }
  console.error("graph schema: up to date");
} else {
  for (const [path, contents] of generatedGraphSchemaFiles()) {
    writeFileSync(path, contents);
    console.error(`  wrote ${relative(root, path)}`);
  }
}
