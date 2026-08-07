#!/usr/bin/env node
/**
 * forgejo-warden bin launcher.
 *
 * Committed so it exists at npm pack-validation time (before `prepack`/`build`
 * runs). It loads the built dist/cli.js and calls the exported `run()`.
 *
 * (npm validates `bin` paths before `prepack`, so pointing `bin` at dist/cli.js
 * directly would have it stripped — dist/cli.js doesn't exist yet at that
 * moment. A committed launcher survives validation; dist/cli.js is still built
 * and included by prepack.)
 */

import(new URL("../dist/cli.js", import.meta.url).href)
  .then((mod) => mod.run(process.argv.slice(2)))
  .catch((err) => {
    process.stderr.write(`forgejo-warden: fatal: ${err?.message ?? err}\n`);
    process.exit(3);
  });
