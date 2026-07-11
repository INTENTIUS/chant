#!/usr/bin/env tsx
import { generateDocs } from "./docs";

generateDocs({ verbose: true }).catch((err) => {
  console.error(err);
  process.exit(1);
});
