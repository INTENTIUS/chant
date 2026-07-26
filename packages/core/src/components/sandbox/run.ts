import { fork } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { bundleDriver } from "../../discovery/sandbox/bundle";
import { classifyChildError } from "../../discovery/sandbox/child-errors";
import { DiscoveryError, type DiscoveryErrorType } from "../../errors";
import type { Component } from "../component";
import type { DiscoveredComponent } from "../discover";
import { generateComponentDriverSource } from "./driver";

/**
 * chant #1051 — imports every discovered `*.component.ts` file for a build
 * TOGETHER, as one bundled module graph, inside one sandboxed child process,
 * and returns the same shape `discoverComponents`'s own in-process import
 * loop would have produced: named components plus any errors.
 *
 * Isolation mechanics are identical to `../../discovery/sandbox/run.ts`'s
 * `runFallbackFilesSandboxed` (chant #1045 Phase 2 — see that module's doc
 * for the full write-up, verified on Node v24.13.1): `--permission
 * --allow-fs-read=<bundle dir>,<project dir>[,<trusted external package
 * dirs>]`, a spawn-time-scrubbed `env`, and a bounded wait before the child
 * is treated as hung. `bundleDriver` (`../../discovery/sandbox/bundle.ts`) is
 * reused as-is — it is generic over what the driver does, so the same
 * esbuild bundling (and the same `typescript`-stays-external carve-out) that
 * serves the entity path serves this one too.
 */

export interface ComponentSandboxRunResult {
  /** Discovered components from this sandboxed import, keyed by `component.name` — functionally indistinguishable from what `discoverComponents`'s in-process path would have produced for this same file set. */
  components: Map<string, DiscoveredComponent>;
  /** Import/collection/permission errors, already chant-shaped (`../../discovery/sandbox/child-errors.ts` — a permission denial names the file and the operation, never a raw `ERR_ACCESS_DENIED`). */
  errors: DiscoveryError[];
  /** esbuild bundling wall-clock time. */
  bundleMs: number;
  /** Bundle size in bytes. */
  bundleBytes: number;
}

interface ChildComponentEntry {
  name: string;
  component: Component;
  exportName: string;
  filePath: string;
}

interface ChildResponse {
  components: ChildComponentEntry[];
  errors: Array<{ file: string; message: string; type: DiscoveryErrorType }>;
  fatal?: boolean;
}

/** How long to wait for the sandboxed child to report back before treating it as hung and killing it. Generous, matching the entity path's own budget. */
const CHILD_TIMEOUT_MS = 120_000;

function isChildResponse(value: unknown): value is ChildResponse {
  return typeof value === "object" && value !== null && "components" in value && "errors" in value;
}

/**
 * Import `files` (every discovered `*.component.ts` file) together, isolated,
 * in one sandboxed child process, and collect their `Component`-shaped
 * exports — including the duplicate-name check, which runs INSIDE the child
 * over live objects before anything is serialized (`../discover.ts`'s
 * `collectComponents`, bundled into the driver).
 *
 * @param files - Absolute paths to every discovered `*.component.ts` file.
 * @param buildRoot - The directory `discoverComponents` was pointed at — used
 *   to compute the project-directory read allowance, mirroring `../../
 *   discovery/sandbox/run.ts`.
 */
export async function discoverComponentsSandboxed(
  files: readonly string[],
  buildRoot: string,
): Promise<ComponentSandboxRunResult> {
  if (files.length === 0) {
    return { components: new Map(), errors: [], bundleMs: 0, bundleBytes: 0 };
  }

  const driverSource = generateComponentDriverSource({ files });
  const { bundlePath, bundleDir, externalReadPaths, durationMs, bytes } = await bundleDriver(driverSource);

  try {
    let projectRealpath: string;
    try {
      projectRealpath = realpathSync(resolve(buildRoot));
    } catch {
      projectRealpath = resolve(buildRoot);
    }

    const response = await runChildProcess(bundlePath, bundleDir, projectRealpath, externalReadPaths);

    const errors = (response.errors ?? []).map((e) => new DiscoveryError(e.file, e.message, e.type));
    if (response.fatal) {
      return { components: new Map(), errors, bundleMs: durationMs, bundleBytes: bytes };
    }

    const components = new Map<string, DiscoveredComponent>();
    for (const entry of response.components ?? []) {
      components.set(entry.name, {
        component: entry.component,
        exportName: entry.exportName,
        filePath: entry.filePath,
      });
    }
    return { components, errors, bundleMs: durationMs, bundleBytes: bytes };
  } catch (err) {
    return {
      components: new Map(),
      errors: [classifyChildError("", err, "import")],
      bundleMs: durationMs,
      bundleBytes: bytes,
    };
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }
}

/** Fork the bundle under `--permission`, with a scrubbed environment, and resolve with its one IPC message (or reject on crash/timeout/fork error). Mirrors `../../discovery/sandbox/run.ts`'s `runChildProcess`. */
function runChildProcess(
  bundlePath: string,
  bundleDir: string,
  projectRealpath: string,
  externalReadPaths: readonly string[],
): Promise<ChildResponse> {
  return new Promise((resolvePromise, reject) => {
    const readAllowances = [bundleDir, projectRealpath, ...externalReadPaths].map(
      (p) => `--allow-fs-read=${p}`,
    );
    const child = fork(bundlePath, [], {
      execArgv: ["--permission", ...readAllowances],
      // chant #1051 — Node's Permission Model does not gate `process.env`;
      // scrubbing it here is the only way to keep the ambient environment out
      // of untrusted project source's reach, exactly as the entity path does.
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    let settled = false;
    let stderrBuf = "";

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`sandboxed component discovery timed out after ${CHILD_TIMEOUT_MS}ms`));
    }, CHILD_TIMEOUT_MS);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.on("message", (msg: unknown) => {
      if (settled || !isChildResponse(msg)) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise(msg);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `sandboxed component discovery child exited before reporting results (code ${code}, signal ${signal})${stderrBuf.trim() ? `: ${stderrBuf.trim()}` : ""}`,
        ),
      );
    });
  });
}
