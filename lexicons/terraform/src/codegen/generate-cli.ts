#!/usr/bin/env tsx
import { generate, writeGeneratedFiles } from "./generate";
import { dirname } from "path";
import { fileURLToPath } from "url";

// src/codegen/generate-cli.ts -> src/codegen -> src -> package root.
// Two dirnames land in src/ and the first generate writes src/src/generated/ (#1614).
const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const result = await generate({ verbose: true });
writeGeneratedFiles(result, pkgDir);
