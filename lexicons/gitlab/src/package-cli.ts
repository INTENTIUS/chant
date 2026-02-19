#!/usr/bin/env bun
/**
 * Thin entry point for `bun run package` in lexicon-gitlab.
 * Generates src/generated/ and writes dist/ bundle.
 */
import { gitlabPlugin } from "./plugin";
await gitlabPlugin.package({ verbose: true });
