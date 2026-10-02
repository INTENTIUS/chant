#!/usr/bin/env tsx
import { printValidationResult } from "@intentius/chant/codegen/validate";
import { validate } from "./validate";

// printValidationResult throws when a check failed, so `npm run validate` (and prepack) exits non-zero.
printValidationResult(await validate());
