#!/usr/bin/env tsx
/**
 * CLI entry point for `npm run generate` in lexicon-prometheus.
 */
import { generate, writeGeneratedFiles } from "./generate";

const result = await generate({ verbose: true });
writeGeneratedFiles(result);
