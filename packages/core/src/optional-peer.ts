/**
 * esbuild and tsx are optional peer dependencies of `@intentius/chant`. A
 * project that builds or runs its own TypeScript installs them, and chant
 * loads them only at that point. When one is missing, the error is a single
 * line that names the install command.
 */

import { createRequire } from "node:module";

/** The optional peers, with the install command each one's error names. */
const INSTALL: Record<"esbuild" | "tsx", string> = {
  esbuild: "npm i -D esbuild",
  tsx: "npm i -D tsx",
};

/** Whether `err` is node failing to find `name` itself, not something `name` imports. */
function isMissing(err: unknown, name: string): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return false;
  return String((err as Error).message).split("\n")[0]!.includes(`'${name}`);
}

/** The error for a missing optional peer: one line, with the command to run. */
export function missingPeerError(name: keyof typeof INSTALL, neededFor: string): Error {
  return new Error(`chant needs ${name} to ${neededFor}; install it with: ${INSTALL[name]}`);
}

/**
 * Load an optional peer with a dynamic `import()`. `load` is the literal
 * `() => import("esbuild")`, so the specifier stays visible to tools that read it.
 */
export async function importOptionalPeer<T>(name: keyof typeof INSTALL, neededFor: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (isMissing(err, name)) throw missingPeerError(name, neededFor);
    throw err;
  }
}

/** Load an optional peer with `require`, for the synchronous callers that register tsx. */
export function requireOptionalPeer<T>(name: keyof typeof INSTALL, specifier: string, neededFor: string, from: string): T {
  try {
    return createRequire(from)(specifier) as T;
  } catch (err) {
    if (isMissing(err, name)) throw missingPeerError(name, neededFor);
    throw err;
  }
}
