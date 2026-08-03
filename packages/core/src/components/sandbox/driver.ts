import { join, resolve } from "node:path";
import { params as currentBuildParams } from "../../params";

/**
 * chant #1051 — generates the source of the "driver" module that runs INSIDE
 * the sandboxed child for component discovery. Mirrors `../../discovery/
 * sandbox/driver.ts`'s shape (chant #1045 Phase 2) but is materially simpler:
 * a `Component` is plain JSON (no `AttrRef` cross-references to resolve), so
 * there is no equivalent of `resolveAttrRefs`/`encodeEntitySet` here — the
 * driver hands back its collected components with a bare, structural
 * `JSON.stringify` over the IPC channel (see `./run.ts`'s `send`).
 *
 * Like the entity driver, every file is imported via a LITERAL string
 * specifier dynamic `import()` — not a variable — so esbuild's bundler can
 * trace and inline it into ONE self-contained module graph (see `../../
 * discovery/sandbox/driver.ts`'s doc for why that's verified to lower to a
 * lazily-invoked local module initializer, not a runtime resolution). That
 * single module graph is what lets `collectComponents`'s duplicate-name check
 * (`../discover.ts`) run over real, live object identity — "the same
 * component re-exported under two bindings" only detects correctly when both
 * bindings really do resolve to the same in-memory object, which requires
 * every `*.component.ts` file for one discovery call to share one module
 * cache inside a single child (see `../discover.ts`'s `collectComponents` doc
 * for the full identity-correctness argument).
 */

const HERE = import.meta.dirname;
const COMPONENTS_DIR = join(HERE, "..");

/** Absolute paths to chant's OWN trusted modules the generated driver imports — resolved relative to THIS file's own location on disk, exactly like `../../discovery/sandbox/driver.ts` does for the entity path (works whether chant runs from the monorepo or a consumer's `node_modules`). */
const DISCOVER_MODULE = join(COMPONENTS_DIR, "discover.ts");
const CHILD_ERRORS_MODULE = join(COMPONENTS_DIR, "..", "discovery", "sandbox", "child-errors.ts");
// chant #1108 — same re-binding the entity driver does (see ../../discovery/
// sandbox/driver.ts's PARAMS_MODULE doc): the child's copy of the shared
// `params` object starts empty, so a `*.component.ts` file importing
// `@intentius/chant/params` would otherwise see `{}` under sandboxed
// discovery no matter what the parent resolved.
const PARAMS_MODULE = join(COMPONENTS_DIR, "..", "params.ts");

export interface GenerateComponentDriverOptions {
  /** Absolute paths to every discovered `*.component.ts` file for this build. */
  files: readonly string[];
}

/** Escape a value for embedding as a JS/TS source-level literal. */
function lit(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Generate the component driver module's full TypeScript source. Written to
 * a tmp file and bundled (`../../discovery/sandbox/bundle.ts`'s `bundleDriver`
 * — generic, reused as-is) before being handed to a sandboxed child — never
 * executed directly by the parent process.
 */
export function generateComponentDriverSource(options: GenerateComponentDriverOptions): string {
  const { files } = options;

  const lines: string[] = [
    `import { collectComponents } from ${lit(DISCOVER_MODULE)};`,
    `import { classifyChildError } from ${lit(CHILD_ERRORS_MODULE)};`,
    `import { setBuildParams } from ${lit(PARAMS_MODULE)};`,
    ``,
    // chant #1108 — snapshot of the parent's resolved build-time parameter
    // values (scalars only), bound before any component file is imported.
    `setBuildParams(${lit({ ...currentBuildParams })});`,
    ``,
    `function send(payload) {`,
    `  if (typeof process.send === "function") process.send(payload);`,
    `  else console.log(JSON.stringify(payload));`,
    `}`,
    ``,
    `async function main() {`,
    `  const modules = [];`,
    `  const errors = [];`,
  ];

  for (const file of files) {
    // `file` (as discovered by `findComponentFiles`, `../discover.ts`) may be
    // relative to whatever cwd-relative `path` `discoverComponents` was
    // called with — `chant list --components examples/foo` never resolves
    // its argument before discovery, matching the unsandboxed import loop's
    // own tolerance for that (`pathToFileURL(resolve(filePath)).href`, see
    // `../discover.ts`'s `importAndCollectComponents`). A bare relative
    // string hits Node's *bare-specifier* (package) resolution instead of
    // being treated as a path, so only the import target — never the `file`
    // key `collectComponents` dedupes and reports by — is resolved to an
    // absolute filesystem path here, in THIS (parent) process, before being
    // embedded as a literal in the bundled child (mirrors `../../discovery/
    // sandbox/driver.ts`'s own literal-specifier `import()`s, which are
    // likewise plain absolute paths, not `file://` URLs — kept that way
    // rather than converting to a URL since esbuild's bundler is only
    // verified to trace/inline a literal filesystem-path specifier).
    const absoluteFile = resolve(file);
    lines.push(
      `  try {`,
      `    const mod = await import(${lit(absoluteFile)});`,
      `    modules.push({ file: ${lit(file)}, exports: mod });`,
      `  } catch (err) {`,
      `    errors.push(classifyChildError(${lit(file)}, err).toJSON());`,
      `  }`,
    );
  }

  lines.push(
    ``,
    `  const collected = collectComponents(modules);`,
    `  for (const err of collected.errors) errors.push(err.toJSON());`,
    ``,
    // Plain JSON: no entity-wire codec needed (see this module's doc + chant
    // #1051's issue — `projectToJson`, ../component.ts, already proves the
    // bare JSON.parse(JSON.stringify()) round-trip for a Component).
    `  const components = [];`,
    `  for (const [name, discovered] of collected.components) {`,
    `    components.push({ name, component: discovered.component, exportName: discovered.exportName, filePath: discovered.filePath });`,
    `  }`,
    `  send({ components, errors });`,
    `}`,
    ``,
    `main().catch((err) => {`,
    `  send({ components: [], errors: [classifyChildError("", err).toJSON()], fatal: true });`,
    `});`,
  );

  return lines.join("\n");
}
