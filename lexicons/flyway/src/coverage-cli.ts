#!/usr/bin/env bun
import { analyzeFlywyCoverage } from "./coverage";

await analyzeFlywyCoverage({ verbose: true });
