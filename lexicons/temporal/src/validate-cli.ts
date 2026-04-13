#!/usr/bin/env tsx
import { validate } from "./validate";

const result = await validate({ verbose: true });
if (result.failed > 0) {
  process.exit(1);
}
