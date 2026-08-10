#!/usr/bin/env tsx
/**
 * Thin entry point for `npm run docs` in lexicon-cedar.
 */
import { generateDocs } from "./docs";

await generateDocs({ verbose: true });
