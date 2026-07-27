/**
 * chant #1113 — what a `chant.config.ts` may contain if it is to be evaluated
 * inside the sandbox boundary and handed back to the CLI as data.
 *
 * Under `--sandbox` the config file is evaluated in a child process (see
 * `./config-run.ts`), so the only thing that can come back is what survives a
 * process boundary: JSON. Node's IPC channel serializes with `JSON.stringify`
 * by default, and `JSON.stringify` is *lossy without complaining* — a function
 * property vanishes, a `Date` becomes a string, a `Map` becomes `{}`, `NaN`
 * becomes `null`. Silently handing the CLI a config that differs from the one
 * the project wrote is the worst available outcome for a security feature, so
 * this module walks the value FIRST and reports every offending key path.
 * `./config-run.ts` turns a non-empty report into a build error that names the
 * keys; nothing is ever dropped quietly.
 *
 * This module is bundled INTO the generated config driver (`./driver.ts`'s
 * `generateConfigDriverSource`) and runs inside the sandboxed child, next to
 * the project code it is inspecting — so it must not import anything, and must
 * not touch the filesystem, the environment or the process.
 *
 * chant #1131 reuses the same walk for the OTHER direction: a `lint.policies`
 * check runs inside a sandboxed child and its `PostSynthDiagnostic[]` has to
 * come back as data (`./policy-wire.ts`). That is the same "JSON is lossy
 * without complaining" problem with a different root value, so the walk is
 * exported as {@link scanValueWireSafety} rather than copied.
 *
 * ## What `ChantConfig` legally holds
 *
 * Every field of `ChantConfig` (`../../config.ts`) is JSON data: string arrays
 * (`lexicons`, `capabilities`, `environments`), strings (`sourceDir`), nested
 * plain objects of strings/booleans (`ownership`, `build`, `release`, `sbom`,
 * `signing`, `vulnPolicy`), arrays of plain objects (`stacks`), and records of
 * plain objects (`buildParams`). `lint` is a `LintConfig`, whose rule values
 * are a severity string or a `[severity, options]` tuple, and whose `plugins`
 * / `policies` are file *paths* — chant loads those modules itself, they are
 * not functions embedded in the config. So the declared type admits nothing
 * that fails the check below.
 *
 * The one way to get there is `ChantConfigSchema`'s `.passthrough()`, which
 * accepts unknown extra keys of any type (that is how a lexicon extends the
 * config — `temporal:` in the temporal lexicon's `TemporalChantConfig`, itself
 * pure data). A project that parks a function under such a key gets a clear
 * error naming it, rather than a config that silently lost it.
 *
 * ## The one accepted lossy case: `undefined` object properties
 *
 * `{ sourceDir: undefined }` and `{}` are indistinguishable to every reader of
 * `ChantConfig` — each field is optional and every resolver tests
 * `config.x === undefined` / `?.` — so an `undefined`-valued property is
 * dropped rather than rejected, exactly as omitting the key would be. An
 * `undefined` inside an ARRAY is a different story (`JSON.stringify` rewrites
 * it to `null`, changing the element), and is reported.
 */

/** One value in the config that cannot cross the sandbox boundary as data. */
export interface ConfigWireOffender {
  /** Dotted/bracketed path from the config root, e.g. `lint.rules.foo` or `stacks[0].name`. */
  path: string;
  /** What was found there, phrased for an error message (e.g. `a function`, `a Date`). */
  found: string;
}

/** Deepest nesting `scanConfigWireSafety` will walk before reporting the path as too deep (also the cycle backstop for exotic self-referential structures). */
const MAX_DEPTH = 64;

function describe(value: unknown): string {
  const t = typeof value;
  if (t === "function") return "a function";
  if (t === "symbol") return "a symbol";
  if (t === "bigint") return "a bigint";
  if (t === "number") return Number.isNaN(value) ? "NaN" : "a non-finite number";
  if (value instanceof Date) return "a Date";
  if (value instanceof RegExp) return "a RegExp";
  if (value instanceof Map) return "a Map";
  if (value instanceof Set) return "a Set";
  if (value instanceof Promise) return "a Promise";
  if (value instanceof Error) return "an Error";
  const ctor = (value as { constructor?: { name?: unknown } })?.constructor?.name;
  return typeof ctor === "string" && ctor !== "Object" ? `a ${ctor} instance` : "a non-plain object";
}

/** A plain object literal (or a null-prototype object) — anything else with `typeof "object"` is a class instance chant refuses to guess at. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(
  value: unknown,
  path: string,
  depth: number,
  seen: Set<object>,
  out: ConfigWireOffender[],
): void {
  if (value === null) return;

  const t = typeof value;
  if (t === "string" || t === "boolean") return;
  if (t === "number") {
    if (!Number.isFinite(value as number)) out.push({ path, found: describe(value) });
    return;
  }
  if (t === "function" || t === "symbol" || t === "bigint" || t === "undefined") {
    // `undefined` reaches here only from an array slot — an object property
    // holding `undefined` is skipped by the caller (see the module doc).
    out.push({ path, found: t === "undefined" ? "undefined" : describe(value) });
    return;
  }

  const obj = value as object;
  if (seen.has(obj)) {
    out.push({ path, found: "a circular reference" });
    return;
  }
  if (depth > MAX_DEPTH) {
    out.push({ path, found: `nested more than ${MAX_DEPTH} levels deep` });
    return;
  }

  if (Array.isArray(obj)) {
    seen.add(obj);
    for (let i = 0; i < obj.length; i++) walk(obj[i], `${path}[${i}]`, depth + 1, seen, out);
    seen.delete(obj);
    return;
  }

  if (!isPlainObject(obj)) {
    out.push({ path, found: describe(obj) });
    return;
  }

  seen.add(obj);
  for (const key of Object.keys(obj)) {
    const child = (obj as Record<string, unknown>)[key];
    if (child === undefined) continue; // dropped, equivalent to omitting the key — see the module doc
    const childPath = path ? `${path}.${key}` : key;
    walk(child, childPath, depth + 1, seen, out);
  }
  seen.delete(obj);
}

/**
 * chant #1131 — report every value ANYWHERE in `value` that cannot cross the
 * sandbox boundary as JSON, with paths rooted at `rootPath`.
 *
 * {@link scanConfigWireSafety} is the config-shaped entry point (it tolerates a
 * module namespace object at the root); this one takes the value as given, so
 * an array root (`diagnostics`) or a plain object root both work. Same rules,
 * same `undefined`-object-property allowance — see the module doc.
 */
export function scanValueWireSafety(value: unknown, rootPath = ""): ConfigWireOffender[] {
  const out: ConfigWireOffender[] = [];
  walk(value, rootPath, 0, new Set<object>(), out);
  return out;
}

/**
 * Report every value in `config` that cannot cross the sandbox boundary as
 * JSON. An empty array means a `JSON.parse(JSON.stringify(config))` round-trip
 * preserves the configuration exactly (modulo `undefined` object properties,
 * which are dropped — see the module doc).
 *
 * `config` itself may be a module namespace object (`await import(...)` with
 * no `default` export), which is not a plain object; its own enumerable keys
 * are walked the same way rather than being reported wholesale.
 */
export function scanConfigWireSafety(config: unknown): ConfigWireOffender[] {
  const out: ConfigWireOffender[] = [];
  if (config === null || typeof config !== "object") {
    // A non-object config is what `normalizeConfig` already rejects in the
    // parent; nothing to say about serializability.
    return out;
  }
  const seen = new Set<object>();
  seen.add(config);
  for (const key of Object.keys(config as Record<string, unknown>)) {
    const child = (config as Record<string, unknown>)[key];
    if (child === undefined) continue;
    walk(child, key, 1, seen, out);
  }
  return out;
}

/** Render a {@link ConfigWireOffender} list as the body of a build error — one line per offending key, most specific information first. */
export function formatConfigWireOffenders(
  configPath: string,
  offenders: readonly ConfigWireOffender[],
): string {
  const lines = offenders.map((o) => `  ${o.path || "<root>"}: ${o.found}`);
  return [
    `Cannot evaluate ${configPath} inside the --sandbox boundary: it holds values that are not data.`,
    ...lines,
    `Under --sandbox the config is evaluated in an isolated child process and only JSON crosses back, so every value must be a string, number, boolean, null, array or plain object. Move the offending value out of chant.config.ts (lint rule plugins and policy checks are referenced by path, not embedded), or drop --sandbox for this build.`,
  ].join("\n");
}
