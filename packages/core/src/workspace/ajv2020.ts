/**
 * The Ajv 2020-12 validator class, loaded on first use: ajv costs start-up
 * time, and most commands validate nothing with it. One loader for every
 * schema check in workspace/, so the slim wave-job runtime (#3896,
 * `../../scripts/build-wave-runtime.mjs`) can swap in a bundled ajv here
 * instead of a `require` resolved next to an installed chant.
 */
import { createRequire } from "node:module";

export type Ajv2020Class = new (opts: object) => { compile(schema: object): unknown };

export function loadAjv2020(): Ajv2020Class {
  const require = createRequire(import.meta.url);
  // ajv is CommonJS; its class is the default export, or that export's own default.
  const mod = require("ajv/dist/2020") as { default?: unknown };
  return (mod.default ?? mod) as Ajv2020Class;
}
