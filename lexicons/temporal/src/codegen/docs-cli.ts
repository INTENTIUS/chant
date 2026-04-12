#!/usr/bin/env tsx
/**
 * CLI entry point for `npm run docs` in lexicon-temporal.
 */
import { generateDocs } from "./docs";

await generateDocs({ verbose: true });
