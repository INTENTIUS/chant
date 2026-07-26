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
