// chant #2526 — the loader hooks module-recorder.mjs registers. They run on
// the loader thread, so they write straight to the log file rather than
// posting back to the main thread.

import { appendFileSync } from "node:fs";

let log;

export function initialize(data) {
  log = data?.log;
}

function record(url) {
  if (log && url.startsWith("file:")) appendFileSync(log, `${url}\n`);
}

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  record(result.url);
  return result;
}

export async function load(url, context, nextLoad) {
  record(url);
  return nextLoad(url, context);
}
