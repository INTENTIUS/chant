#!/usr/bin/env bun
/**
 * Script to create a minimal CI schema fixture for tests.
 * Run once: bun run src/testdata/create-fixture.ts
 */

import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const schema = JSON.parse(readFileSync(join(homedir(), ".chant", "gitlab-ci-schema.json"), "utf-8"));

const neededDefs = [
  "job_template", "image", "services", "artifacts", "cache_item",
  "rules", "retry", "allow_failure", "parallel", "include_item",
  "when", "retry_errors", "workflowAutoCancel",
  "before_script", "after_script", "script", "optional_script",
  "globalVariables", "jobVariables", "rulesVariables",
  "id_tokens", "secrets", "timeout", "start_in",
];

const defs: Record<string, unknown> = {};
for (const name of neededDefs) {
  if (schema.definitions?.[name]) {
    defs[name] = schema.definitions[name];
  }
}

const keepProps = ["default", "workflow", "stages", "variables", "include"];
const filteredProps: Record<string, unknown> = {};
for (const key of keepProps) {
  if (schema.properties?.[key]) filteredProps[key] = schema.properties[key];
}

const minimal = {
  definitions: defs,
  properties: filteredProps,
  patternProperties: schema.patternProperties || {},
  required: schema.required || [],
};

const outPath = join(import.meta.dir, "ci-schema-fixture.json");
writeFileSync(outPath, JSON.stringify(minimal, null, 2));
console.log(`Fixture written to ${outPath}`);
console.log(`Definitions: ${Object.keys(defs).length}`);
console.log(`Missing: ${neededDefs.filter(n => !defs[n]).join(", ") || "none"}`);
