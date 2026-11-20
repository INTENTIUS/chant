/**
 * The Ajv 2020-12 validator class for agent step schemas (#5358), loaded on
 * first use, as `../workspace/ajv2020.ts` loads it. A module of its own so
 * the pipeline spec, which level-0 commands load, reaches no workspace
 * module; the slim wave-job runtime swaps it for its bundled ajv the same
 * way (`../../scripts/build-wave-runtime.mjs`).
 */
import { createRequire } from "node:module";

export type AgentAjvClass = new (opts: object) => { compile(schema: object): unknown };

export function loadAgentAjv(): AgentAjvClass {
  const require = createRequire(import.meta.url);
  // ajv is CommonJS; its class is the default export, or that export's own default.
  const mod = require("ajv/dist/2020") as { default?: unknown };
  return (mod.default ?? mod) as AgentAjvClass;
}
