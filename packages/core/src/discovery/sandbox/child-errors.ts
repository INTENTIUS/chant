import { DiscoveryError, type DiscoveryErrorType } from "../../errors";

/**
 * chant #1045 Phase 2 — turns whatever the sandboxed child's per-file import
 * (or its own collect/resolve/encode step) throws into an actionable chant
 * {@link DiscoveryError} that names the file AND the operation, instead of
 * leaking a raw `ERR_ACCESS_DENIED` with no context.
 *
 * This module is bundled INTO the generated sandbox driver (see `./driver.ts`)
 * — it runs inside the sandboxed child, alongside the untrusted project
 * source it's classifying errors for — so it must not import anything that
 * isn't already safe to bundle (no filesystem/process access of its own).
 */

/**
 * Node's Permission Model error shape for `ERR_ACCESS_DENIED` — see
 * https://nodejs.org/api/permissions.html#error-classes. `permission` names
 * the guarded API family (`FileSystemRead`, `FileSystemWrite`,
 * `ChildProcess`, `WorkerThreads`, `SqliteWrite`, …); `resource` is the
 * specific path or target that was denied. Verified empirically on Node
 * v24.13.1 (chant#1045 Phase 2 prototype) — both fields are present on the
 * thrown `Error` alongside `code`.
 */
interface NodePermissionError {
  code?: unknown;
  permission?: unknown;
  resource?: unknown;
  message?: unknown;
}

function isPermissionDenied(err: unknown): err is NodePermissionError {
  return typeof err === "object" && err !== null && (err as NodePermissionError).code === "ERR_ACCESS_DENIED";
}

/**
 * Classify one error raised while executing run-fallback project source (or
 * chant's own collect/resolve/encode step) inside the sandboxed child.
 *
 * @param file - The project source file being executed when `err` was
 *   thrown, or `""` for an error not attributable to one specific file (e.g.
 *   `collectEntities`/`resolveAttrRefs` over the whole batch).
 * @param fallbackType - The {@link DiscoveryErrorType} to use when `err`
 *   isn't a permission denial — mirrors how `discover()` itself types a
 *   plain import failure `"import"` vs. a collection/resolution failure
 *   `"resolution"`.
 */
export function classifyChildError(
  file: string,
  err: unknown,
  fallbackType: DiscoveryErrorType = "import",
): DiscoveryError {
  if (isPermissionDenied(err)) {
    const operation = typeof err.permission === "string" ? err.permission : "an unrecognized sandboxed operation";
    const resource = typeof err.resource === "string" ? ` (${err.resource})` : "";
    const where = file ? `"${file}"` : "sandboxed run-fallback code";
    return new DiscoveryError(
      file,
      `sandbox denied ${operation}${resource}: ${where} attempted an operation outside the sandbox's allowlist`,
      "permission",
    );
  }

  const message = err instanceof Error ? err.message : String(err);
  return new DiscoveryError(file, message, fallbackType);
}
