/**
 * The kustomize renderer (#1548) — one implementation, two consumers.
 *
 * Piece 1 (`components/kustomize-apply.ts`) renders at DEPLOY time in front
 * of the server-side applier; piece 3 (`./root.ts`) renders at BUILD time to
 * give an overlay estate a declared side. Both run the same command with the
 * same fallback through the same injectable runner, so a test asserts the
 * exact invocation without either binary installed and the two paths cannot
 * drift apart on how an overlay is rendered.
 *
 * Renderer resolution: `kustomize build`, falling back to `kubectl
 * kustomize` (the same renderer vendored into kubectl) when the standalone
 * binary is absent. When NEITHER binary exists the failure names both — a
 * missing renderer is an environment problem the operator can fix in one
 * install, and it must read as that, not as a stack trace. A render failure
 * from an existing binary (a broken overlay, a missing base) propagates
 * untouched: that error text is kustomize's own diagnosis and is strictly
 * better than anything this module could wrap it in.
 *
 * The 64MiB maxBuffer mirrors helm-upgrade's — a big overlay renders
 * megabytes.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { loadAll } from "js-yaml";

const execAsync = promisify(exec);

/** Injectable shell runner — the helm-upgrade seam, same buffer bound. */
export type KustomizeRunner = (command: string) => Promise<{ stdout: string }>;

export const defaultKustomizeRunner: KustomizeRunner = (command) =>
  execAsync(command, { maxBuffer: 64 * 1024 * 1024 });

/** Single-quote shell escaping, as helm-upgrade quotes its argv. */
function q(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

/** The exact render command, standalone binary first. Pure; exported for tests. */
export function renderCommand(dir: string, tool: "kustomize" | "kubectl" = "kustomize"): string {
  return tool === "kustomize" ? `kustomize build ${q(dir)}` : `kubectl kustomize ${q(dir)}`;
}

/** Does this error mean "the binary is not installed" (vs "the render failed")? */
function isMissingBinary(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /ENOENT|not found|command not found|127/.test(message);
}

/**
 * Render the kustomization at `dir` and parse the emitted YAML into document
 * objects. Falls back to kubectl's vendored kustomize when the standalone
 * binary is missing; when both binaries are missing, fails with a message
 * naming them.
 */
export async function renderKustomizeDocuments(
  dir: string,
  run: KustomizeRunner = defaultKustomizeRunner,
): Promise<Array<Record<string, unknown>>> {
  let stdout: string;
  try {
    ({ stdout } = await run(renderCommand(dir, "kustomize")));
  } catch (err) {
    if (!isMissingBinary(err)) throw err;
    try {
      ({ stdout } = await run(renderCommand(dir, "kubectl")));
    } catch (err2) {
      if (isMissingBinary(err2)) {
        throw new Error(
          `Cannot render kustomization "${dir}": neither the \`kustomize\` binary nor \`kubectl\` ` +
            `(whose vendored \`kubectl kustomize\` is the fallback) was found on PATH. ` +
            `Install kustomize or kubectl and retry.`,
        );
      }
      throw err2;
    }
  }
  const documents: Array<Record<string, unknown>> = [];
  for (const doc of loadAll(stdout)) {
    if (doc && typeof doc === "object" && !Array.isArray(doc)) documents.push(doc as Record<string, unknown>);
  }
  return documents;
}
