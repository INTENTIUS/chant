#!/usr/bin/env tsx
/**
 * CLI entry point for `npm run generate` in lexicon-forgejo.
 */
import { generate } from "./generate";

const result = await generate({ verbose: true });
console.error(`forgejo: ${result.resources} resources (reuses github's wholesale)`);
