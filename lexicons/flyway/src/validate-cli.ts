#!/usr/bin/env bun
import { validate } from "./validate";
import { printValidationResult } from "@intentius/chant/codegen/validate";

const result = await validate();
printValidationResult(result);
