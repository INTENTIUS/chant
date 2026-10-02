#!/usr/bin/env tsx
import { generate, writeGeneratedFiles } from "./generate";

// `npm run generate -- --force` reads the pinned server even when the snapshot matches the pin.
const result = await generate({ verbose: true, force: process.argv.includes("--force") });
writeGeneratedFiles(result);
