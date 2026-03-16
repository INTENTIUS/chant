#!/usr/bin/env bun
import { validate } from "./validate";
import { printValidationResult } from "@intentius/chant/codegen/validate";

async function main() {
  const result = await validate();
  printValidationResult(result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
