#!/usr/bin/env bun
import { generate, writeGeneratedFiles } from "./generate";
import { dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const result = await generate({ verbose: true });
writeGeneratedFiles(result, pkgDir);
