import { dirname, join } from "node:path";

/**
 * chant #1045 Phase 2 — generates the source of the "driver" module that runs
 * INSIDE the sandboxed child. See `./run.ts` for the orchestration this feeds
 * (bundle the generated source with esbuild, then spawn a permission-limited
 * child on the bundle) and `../fold-import.ts`'s long doc comment for why
 * every run-fallback file for a build must execute together, in one process,
 * sharing one module graph.
 *
 * The driver imports each run-fallback file via a LITERAL string specifier
 * dynamic `import()` — not a variable — so esbuild's bundler can still trace
 * and inline it (verified: esbuild lowers a literal-specifier `import()` to a
 * lazily-invoked local module initializer, not a runtime resolution), while
 * keeping the SAME per-file try/catch resilience `discover()`'s own run loop
 * has today (one file throwing at import time doesn't take down the whole
 * batch). A literal, per-build-generated import graph is exactly what lets
 * the whole bundle be self-contained: esbuild resolves every project file,
 * lexicon package, and node_modules dependency transitively, ONCE, so the
 * sandboxed child never needs to resolve a module from disk at runtime.
 *
 * Chant's own trusted collection/resolution/encoding step
 * (`collectEntities`/`resolveAttrRefs`/`encodeEntitySet`) runs INSIDE the
 * child too, after every file has been imported — this is what lets naming
 * and AttrRef resolution happen "inside the boundary" for the run-fallback
 * set (mirrors `discoverEntitySetJson`'s doc in `../entity-wire.ts`), so the
 * child can hand back a fully-named, ref-resolved `EntitySetWire` rather than
 * raw, identity-bearing module exports that couldn't cross the process
 * boundary at all.
 */

const HERE = import.meta.dirname;
const DISCOVERY_DIR = join(HERE, "..");

/** Absolute paths to chant's OWN trusted modules the generated driver imports — always resolved relative to THIS file's own location on disk, so this works whether chant is running from the monorepo or from a consumer's `node_modules` (both route runtime resolution at `src/*.ts` — see `packages/core/package.json`'s `development`/`default` export conditions). */
const COLLECT_MODULE = join(DISCOVERY_DIR, "collect.ts");
const RESOLVE_MODULE = join(DISCOVERY_DIR, "resolve.ts");
// The pure codec, NOT `entity-wire.ts` — that file also exports
// `discoverEntitySetJson`, which pulls in `discover()` → `fold-import` →
// the `typescript` compiler package. See `../entity-wire.ts`'s module doc.
const ENTITY_WIRE_CODEC_MODULE = join(DISCOVERY_DIR, "entity-wire-codec.ts");
const CHILD_ERRORS_MODULE = join(HERE, "child-errors.ts");
const PROVENANCE_MODULE = join(dirname(DISCOVERY_DIR), "provenance.ts");
// chant #1113 — the config driver's serializability contract (see ./config-wire.ts).
const CONFIG_WIRE_MODULE = join(HERE, "config-wire.ts");
// chant #1131 — the policy driver's build-result decoding + diagnostics contract.
const POLICY_WIRE_MODULE = join(HERE, "policy-wire.ts");
const POST_SYNTH_MODULE = join(dirname(DISCOVERY_DIR), "lint", "post-synth.ts");

export interface GenerateDriverOptions {
  /** Absolute paths to the run-fallback files this build decided NOT to fold — see `discover()`'s fold/taint loop in `../index.ts`. */
  files: readonly string[];
  /** The build root — threaded to `collectEntities` exactly as `discover()` threads its own `path` argument, so cross-directory stack-prefix disambiguation (chant #932) is computed the same way for this subset. */
  buildRoot: string;
}

/** Escape a value for embedding as a JS/TS source-level literal. */
function lit(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Generate the driver module's full TypeScript source. Written to a tmp file
 * and bundled (see `./bundle.ts`) before being handed to a sandboxed child —
 * never executed directly by the parent process.
 */
export function generateDriverSource(options: GenerateDriverOptions): string {
  const { files, buildRoot } = options;

  const lines: string[] = [
    `import { collectEntities } from ${lit(COLLECT_MODULE)};`,
    `import { resolveAttrRefs } from ${lit(RESOLVE_MODULE)};`,
    `import { encodeEntitySet } from ${lit(ENTITY_WIRE_CODEC_MODULE)};`,
    `import { classifyChildError } from ${lit(CHILD_ERRORS_MODULE)};`,
    `import { getProvenance } from ${lit(PROVENANCE_MODULE)};`,
    ``,
    `const BUILD_ROOT = ${lit(buildRoot)};`,
    ``,
    `function send(payload) {`,
    `  if (typeof process.send === "function") process.send(payload);`,
    `  else console.log(JSON.stringify(payload));`,
    `}`,
    ``,
    // collectEntities (bundled, real DiscoveryError instances) already names
    // the exact offending file on a same-directory duplicate — reuse that
    // instead of reporting an empty file, which is what forwarding a bare ""
    // through classifyChildError would otherwise do.
    `function errFile(err) {`,
    `  return err && typeof err === "object" && typeof err.file === "string" ? err.file : "";`,
    `}`,
    ``,
    `async function main() {`,
    `  const modules = [];`,
    `  const errors = [];`,
  ];

  for (const file of files) {
    lines.push(
      `  try {`,
      `    const mod = await import(${lit(file)});`,
      `    modules.push({ file: ${lit(file)}, exports: mod });`,
      `  } catch (err) {`,
      `    errors.push(classifyChildError(${lit(file)}, err).toJSON());`,
      `  }`,
    );
  }

  lines.push(
    ``,
    `  let entities = new Map();`,
    `  try {`,
    `    entities = collectEntities(modules, BUILD_ROOT);`,
    `  } catch (err) {`,
    `    errors.push(classifyChildError(errFile(err), err, "resolution").toJSON());`,
    `    send({ entitySet: { entities: [] }, errors, provenanceByName: {} });`,
    `    return;`,
    `  }`,
    ``,
    // Recorded BEFORE resolveAttrRefs/encode — not for the parent's own
    // entities (it never sees this subset's raw exports at all), but so a
    // parent-side merge collision against the fold-only set (chant#1045
    // Phase 2 — a same-directory bare name genuinely exported twice, once
    // folded, once run) can name the real run-fallback file instead of the
    // entity name. See discover()'s merge step in ../index.ts.
    `  const provenanceByName = {};`,
    `  for (const [name, entity] of entities) {`,
    `    const prov = getProvenance(entity);`,
    `    if (prov?.sourceFile) provenanceByName[name] = prov.sourceFile;`,
    `  }`,
    ``,
    `  try {`,
    `    resolveAttrRefs(entities);`,
    `  } catch (err) {`,
    `    errors.push(classifyChildError("", err, "resolution").toJSON());`,
    `  }`,
    ``,
    `  try {`,
    `    const entitySet = encodeEntitySet(entities);`,
    `    send({ entitySet, errors, provenanceByName });`,
    `  } catch (err) {`,
    `    errors.push(classifyChildError("", err, "resolution").toJSON());`,
    `    send({ entitySet: { entities: [] }, errors, provenanceByName });`,
    `  }`,
    `}`,
    ``,
    `main().catch((err) => {`,
    `  send({ entitySet: { entities: [] }, errors: [classifyChildError("", err).toJSON()], provenanceByName: {}, fatal: true });`,
    `});`,
  );

  return lines.join("\n");
}

/**
 * chant #1113 — generate the driver module that evaluates a project's
 * `chant.config.ts` INSIDE the sandboxed child and hands back plain JSON.
 *
 * Same machinery as {@link generateDriverSource} above, deliberately: one
 * literal-specifier dynamic `import()` esbuild can trace and inline, one IPC
 * message back, `./child-errors.ts` for classification so a permission denial
 * names the config file rather than leaking `ERR_ACCESS_DENIED`. The only
 * difference is what crosses — a config is data, not an entity graph, so there
 * is no naming/`AttrRef` step and no `EntitySetWire`; the child instead runs
 * `./config-wire.ts`'s serializability scan and refuses to hand back a config
 * that `JSON.stringify` would silently mangle.
 *
 * The child returns the raw module namespace's chosen export as-is — the
 * `default ?? config ?? namespace` selection and Zod validation
 * (`normalizeConfig`) stay in the parent, where they were, so `--sandbox`
 * changes where the file is *evaluated* and nothing about how its result is
 * interpreted.
 */
export function generateConfigDriverSource(configPath: string): string {
  return [
    `import { classifyChildError } from ${lit(CHILD_ERRORS_MODULE)};`,
    `import { scanConfigWireSafety } from ${lit(CONFIG_WIRE_MODULE)};`,
    ``,
    `function send(payload) {`,
    `  if (typeof process.send === "function") process.send(payload);`,
    `  else console.log(JSON.stringify(payload));`,
    `}`,
    ``,
    `async function main() {`,
    `  let namespace;`,
    `  try {`,
    `    namespace = await import(${lit(configPath)});`,
    `  } catch (err) {`,
    `    send({ kind: "chant-config", ok: false, error: classifyChildError(${lit(configPath)}, err).toJSON() });`,
    `    return;`,
    `  }`,
    ``,
    // Mirrors loadChantConfig's own selection so the scan sees exactly the
    // object the parent will normalize. A namespace object is not a plain
    // object; scanConfigWireSafety walks its own keys rather than rejecting it.
    `  const selected = namespace.default ?? namespace.config ?? namespace;`,
    ``,
    `  const offenders = scanConfigWireSafety(selected);`,
    `  if (offenders.length > 0) {`,
    `    send({ kind: "chant-config", ok: false, offenders });`,
    `    return;`,
    `  }`,
    ``,
    `  try {`,
    // Round-trip here, not just at the IPC boundary: this is what proves the
    // payload really is JSON before it leaves the child, and turns anything
    // the scan somehow missed into a named error instead of a quiet drop.
    `    const config = JSON.parse(JSON.stringify(selected ?? {}));`,
    `    send({ kind: "chant-config", ok: true, config });`,
    `  } catch (err) {`,
    `    send({ kind: "chant-config", ok: false, error: classifyChildError(${lit(configPath)}, err, "resolution").toJSON() });`,
    `  }`,
    `}`,
    ``,
    `main().catch((err) => {`,
    `  send({ kind: "chant-config", ok: false, error: classifyChildError(${lit(configPath)}, err).toJSON() });`,
    `});`,
  ].join("\n");
}

/**
 * chant #1131 — generate the driver module that imports a project's
 * `lint.policies` modules INSIDE the sandboxed child, runs their checks over
 * the build result the parent hands it, and sends back plain
 * `PostSynthDiagnostic`s.
 *
 * Same machinery again: literal-specifier dynamic `import()`s esbuild can trace
 * and inline, `./child-errors.ts` for classification so a permission denial
 * names the policy file, one IPC message back. Two things are specific to this
 * one:
 *
 *  - **It receives before it sends.** The run and config drivers are fully
 *    parameterized by their generated source; a policy check needs the finished
 *    build result, which is neither known at bundle time nor something to bake
 *    into a source literal. It arrives as one IPC message (see `./fork.ts`'s
 *    `send`). The `process.on("message", …)` registration is top-level and
 *    synchronous, so it is in place before the event loop can deliver anything
 *    — a message the parent sent before the child finished booting is queued on
 *    the channel, not lost.
 *  - **Checks run wrapped, not raw.** `runPostSynthChecks` (chant's own, from
 *    `../../lint/post-synth.ts`) is invoked ONCE over every check from every
 *    policy module, exactly as `cli/commands/build.ts` invokes it in-process —
 *    so the checks share one `PostSynthContext` and run in one order, and the
 *    diagnostics come back in the same sequence. The wrapper around each check
 *    is what makes a bad return value attributable: it scans that check's own
 *    output and throws a `PolicyWireError` naming the module the check was
 *    loaded from, rather than reporting an offending index in a merged array.
 */
export function generatePolicyDriverSource(policyPaths: readonly string[]): string {
  const lines: string[] = [
    `import { classifyChildError } from ${lit(CHILD_ERRORS_MODULE)};`,
    `import { decodePolicyBuildResult, scanPolicyDiagnostics, PolicyWireError } from ${lit(POLICY_WIRE_MODULE)};`,
    `import { runPostSynthChecks, isPostSynthCheck } from ${lit(POST_SYNTH_MODULE)};`,
    ``,
    `function send(payload) {`,
    `  if (typeof process.send === "function") process.send(payload);`,
    `  else console.log(JSON.stringify(payload));`,
    `}`,
    ``,
    `function fail(file, err, type) {`,
    `  if (err instanceof PolicyWireError) {`,
    `    send({ kind: "chant-policy", ok: false, offenders: err.offenders });`,
    `    return;`,
    `  }`,
    `  send({ kind: "chant-policy", ok: false, error: classifyChildError(file, err, type).toJSON() });`,
    `}`,
    ``,
    // The wrapper described in the doc above: same id/description so any
    // chant-side reporting keyed off them is unchanged, same ctx, same return
    // value — plus the per-check serializability scan.
    `function guard(check, policy) {`,
    `  return {`,
    `    id: check.id,`,
    `    description: check.description,`,
    `    check(ctx) {`,
    `      const produced = check.check(ctx);`,
    `      const offenders = scanPolicyDiagnostics(produced, policy);`,
    `      if (offenders.length > 0) throw new PolicyWireError(offenders);`,
    `      return produced;`,
    `    },`,
    `  };`,
    `}`,
    ``,
    `async function main(request) {`,
    `  let buildResult;`,
    `  try {`,
    `    buildResult = decodePolicyBuildResult(request.buildResult);`,
    `  } catch (err) {`,
    `    fail("", err, "resolution");`,
    `    return;`,
    `  }`,
    ``,
    `  const checks = [];`,
  ];

  // One block per policy module, in the order `lint.policies` declares them —
  // the same order `loadPolicyChecks` collects in, so the diagnostics sequence
  // matches the in-process one exactly.
  for (const policyPath of policyPaths) {
    lines.push(
      `  try {`,
      `    const mod = await import(${lit(policyPath)});`,
      `    for (const value of Object.values(mod)) {`,
      `      if (isPostSynthCheck(value)) checks.push(guard(value, ${lit(policyPath)}));`,
      `    }`,
      `  } catch (err) {`,
      `    fail(${lit(policyPath)}, err, "import");`,
      `    return;`,
      `  }`,
    );
  }

  lines.push(
    ``,
    `  let diagnostics;`,
    `  try {`,
    `    diagnostics = runPostSynthChecks(checks, buildResult, request.env ?? undefined);`,
    `  } catch (err) {`,
    `    fail("", err, "resolution");`,
    `    return;`,
    `  }`,
    ``,
    `  send({ kind: "chant-policy", ok: true, diagnostics });`,
    `}`,
    ``,
    // Registered synchronously at module top level — see the doc above on why
    // that is what makes the parent's send-before-boot safe.
    //
    // Removed again as soon as the input arrives, and that is not tidiness: a
    // `message` listener REFS the IPC channel, so leaving it registered would
    // keep this child's event loop alive after it had already answered — and a
    // live channel keeps the PARENT's alive too. `chant build` would not have
    // noticed (`cli/main.ts` ends in `process.exit`); anything embedding chant
    // as a library would have hung. `./fork.ts` kills the child on receipt as
    // the other half of the same fix.
    `let started = false;`,
    `function onRequest(request) {`,
    `  if (started) return;`,
    `  if (!request || request.kind !== "chant-policy-request") return;`,
    `  started = true;`,
    `  process.off("message", onRequest);`,
    `  main(request).catch((err) => fail("", err, "resolution"));`,
    `}`,
    `process.on("message", onRequest);`,
  );

  return lines.join("\n");
}
