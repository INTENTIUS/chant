#!/usr/bin/env tsx
import { validate } from "./validate";
import { printValidationResult } from "@intentius/chant/codegen/validate";

// `validate` returns a result; printing it is what turns a failed check into a
// non-zero exit. Calling it and discarding the answer exits 0 whatever the
// registry looks like — the same scaffold bug cedar carried.
printValidationResult(await validate());
