// chant #2526 — records every module a chant process loads.
//
// The level-0 goldens start each CLI process as
// `node --import tsx/dist/loader.mjs --import <this file> cli/main.ts`, with
// CHANT_LEVEL0_MODULE_LOG naming a file. Every module URL the ESM loader
// resolves or loads is appended to that file, one per line, and every
// CommonJS file in require.cache is appended when the process exits.
//
// Order matters. Hooks registered last run first, so registering after tsx
// means these see each URL before tsx rewrites or answers it. The cost is that
// the recorder is a command-line flag rather than NODE_OPTIONS, so a child
// process chant spawns is not recorded. None of the commands the goldens run
// loads project code in a child; `--sandbox` would, and is not a level-0 path
// these pin.

import { appendFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { pathToFileURL } from "node:url";

const log = process.env.CHANT_LEVEL0_MODULE_LOG;

if (log) {
  register(new URL("./module-recorder-hooks.mjs", import.meta.url), { data: { log } });

  const require = createRequire(import.meta.url);
  process.on("exit", () => {
    const files = Object.keys(require.cache).map((file) => pathToFileURL(file).href);
    if (files.length > 0) appendFileSync(log, `${files.join("\n")}\n`);
  });
}
