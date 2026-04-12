#!/usr/bin/env tsx
import { validate } from "./validate";
import { printValidationResult } from "@intentius/chant/codegen/validate";

const result = await validate();
printValidationResult(result);
