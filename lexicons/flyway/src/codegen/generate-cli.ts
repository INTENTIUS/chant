#!/usr/bin/env bun
import { generate } from "./generate";

const result = await generate({ verbose: true });
console.error(`Generated ${result.resources} resources, ${result.properties} property types`);
if (result.warnings.length > 0) {
  console.error(`${result.warnings.length} warnings`);
}
