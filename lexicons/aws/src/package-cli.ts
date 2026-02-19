#!/usr/bin/env bun
/**
 * Thin entry point for `bun run package` in lexicon-aws.
 * Generates src/generated/ and writes dist/ bundle.
 */
import { awsPlugin } from "./plugin";
await awsPlugin.package({ verbose: true });
