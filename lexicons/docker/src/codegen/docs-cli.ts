#!/usr/bin/env bun
/**
 * CLI entry for Docker lexicon docs generation.
 */

import { generateDocs } from "./docs";

const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

await generateDocs({ verbose });
