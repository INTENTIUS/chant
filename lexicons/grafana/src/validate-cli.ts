#!/usr/bin/env tsx
import { printValidationResult } from "@intentius/chant/codegen/validate";
import { validate } from "./validate";

const result = await validate();
printValidationResult(result);
if (!result.success) process.exit(1);
