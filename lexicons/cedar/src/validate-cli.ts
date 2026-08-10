#!/usr/bin/env tsx
import { validate } from "./validate";
import { printValidationResult } from "@intentius/chant/codegen/validate";

// `validate` returns a result; printing it is what turns a failed check into a
// non-zero exit. The scaffold called it and discarded the answer, so a missing
// registry exited 0.
printValidationResult(await validate());
