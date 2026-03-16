#!/usr/bin/env bun
import { generateDocs } from "./docs";

generateDocs({ verbose: true }).catch((err) => {
  console.error(err);
  process.exit(1);
});
