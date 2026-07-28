import { realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { Declarable } from "../../declarable";
import { DiscoveryError, type DiscoveryErrorType } from "../../errors";
import { decodeEntitySet, type EntitySetWire } from "../entity-wire-codec";
import { bundleDriver } from "./bundle";
import { classifyChildError } from "./child-errors";
import { generateDriverSource } from "./driver";
import { forkSandboxed } from "./fork";

/**
 * chant #1045 Phase 2 — runs every run-fallback file for a build TOGETHER, as
 * one bundled module graph, inside one sandboxed child process, and returns
 * the same shape `discover()`'s own in-process run path would have produced:
 * a named, ref-resolved entities map plus any errors.
 *
 * Isolation mechanics live in `./fork.ts` — the one function that spawns a
 * sandboxed child, shared with chant #1113's config evaluation
 * (`./config-run.ts`) so the two cannot drift apart. In short:
 * `--permission --allow-fs-read=<bundle dir>,<project dir>[,<trusted external
 * package dirs>]`, a spawn-time environment scrub, no writes, no spawning, no
 * worker threads, and no network guarantee. The "trusted external package
 * dirs" allowance is narrow and specific: `./bundle.ts` deliberately leaves a
 * couple of chant/lexicon-internal dependencies (`typescript`) unbundled and
 * resolves them to their real, fixed location instead — project source never
 * controls what's installed there.
 *
 * What does NOT run inside the child: fold (`tryFoldFile`, `../fold-import`)
 * stays exactly where it is today, in the parent, unsandboxed — fold already
 * executes zero of the file's own top-level code (chant #1022/#1023), so
 * isolating it buys nothing and would only cost a bundle+spawn per build.
 * Only genuine run-fallback files are handed to this function.
 */

export interface SandboxRunResult {
  /** Named, ref-resolved entities from the run-fallback set — decoded from the child's `EntitySetWire` response, functionally indistinguishable from what `importModule` + `collectEntities` + `resolveAttrRefs` would have produced in-process for this same file set (see `../entity-wire.ts`'s `decodeEntitySet` doc). */
  entities: Map<string, Declarable>;
  /** Import/collection/resolution/permission errors, already chant-shaped (see `./child-errors.ts` — a permission denial names the file and the operation, never a raw `ERR_ACCESS_DENIED`). */
  errors: DiscoveryError[];
  /** esbuild bundling wall-clock time — chant#1045 asks this be measured, not silently accepted. */
  bundleMs: number;
  /** Bundle size in bytes. */
  bundleBytes: number;
  /**
   * Entity name → declaring file, for every entity in {@link entities} whose
   * provenance (`../../provenance.ts`) named one. The wire format itself
   * doesn't carry this (`encodeEntitySet` intentionally drops build metadata,
   * not declared configuration) — it rides back as a small side channel so a
   * parent-side merge collision against the fold-only set (a bare name
   * genuinely exported by both a folded and a run-fallback file in the same
   * directory) can name the real file, not the entity name. See `../index.ts`.
   */
  provenanceByName: Record<string, string>;
}

interface ChildResponse {
  entitySet: EntitySetWire;
  errors: Array<{ name: string; file: string; message: string; type: DiscoveryErrorType }>;
  provenanceByName?: Record<string, string>;
  fatal?: boolean;
}

/** How long to wait for the sandboxed child to report back before treating it as hung and killing it. Generous: bundling+import+collect for a whole build's run-fallback set should be a small multiple of what the equivalent in-process run takes. */
const CHILD_TIMEOUT_MS = 120_000;

function isChildResponse(value: unknown): value is ChildResponse {
  return typeof value === "object" && value !== null && "entitySet" in value && "errors" in value;
}

/**
 * Run `files` (already decided "run" by `discover()`'s fold/taint pass)
 * together, isolated, in one sandboxed child process. Returns the same
 * `{ entities, errors }` shape the parent's own `collectEntities` +
 * `resolveAttrRefs` would have — see `../index.ts`'s `discover()`, which
 * merges this result into the entities it collected from folded files.
 *
 * @param files - Absolute paths to run-fallback files.
 * @param buildRoot - The directory `discover()` was pointed at — threaded to
 *   `collectEntities` inside the child (stack-prefix disambiguation, #932)
 *   and used to compute the project-directory read allowance.
 */
export async function runFallbackFilesSandboxed(
  files: readonly string[],
  buildRoot: string,
): Promise<SandboxRunResult> {
  if (files.length === 0) {
    return { entities: new Map(), errors: [], bundleMs: 0, bundleBytes: 0, provenanceByName: {} };
  }

  const driverSource = generateDriverSource({ files, buildRoot });
  const { bundlePath, bundleDir, externalReadPaths, durationMs, bytes } = await bundleDriver(driverSource);

  try {
    let projectRealpath: string;
    try {
      projectRealpath = realpathSync(resolve(buildRoot));
    } catch {
      projectRealpath = resolve(buildRoot);
    }

    const response = await forkSandboxed(
      {
        bundlePath,
        bundleDir,
        projectRealpath,
        externalReadPaths,
        // chant #1045 Phase 2 — Node's Permission Model does not gate
        // `process.env`; scrubbing it at spawn is the only way to keep the
        // ambient environment out of untrusted project source's reach. `PATH`
        // is kept only because some platforms' module resolution/dynamic
        // linking consults it; it carries no project secrets.
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: CHILD_TIMEOUT_MS,
        label: "sandboxed run",
        // chant #1148 — a run-fallback file's own console.log/error no
        // longer goes nowhere; see `./fork.ts`'s `outputPrefix` doc.
        outputPrefix: "[sandbox:run]",
      },
      isChildResponse,
    );

    const errors = (response.errors ?? []).map(
      (e) => new DiscoveryError(e.file, e.message, e.type),
    );
    const provenanceByName = response.provenanceByName ?? {};
    if (response.fatal) {
      return { entities: new Map(), errors, bundleMs: durationMs, bundleBytes: bytes, provenanceByName };
    }
    const entities = decodeEntitySet(response.entitySet ?? { entities: [] });
    return { entities, errors, bundleMs: durationMs, bundleBytes: bytes, provenanceByName };
  } catch (err) {
    return {
      entities: new Map(),
      errors: [classifyChildError("", err, "import")],
      provenanceByName: {},
      bundleMs: durationMs,
      bundleBytes: bytes,
    };
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }
}
