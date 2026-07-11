#!/usr/bin/env tsx
import { validate } from "./validate";
import { printValidationResult } from "@intentius/chant/codegen/validate";

printValidationResult(await validate());
