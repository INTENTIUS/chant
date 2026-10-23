/**
 * The pure helpers over a loaded config's `environments` and `ownership`:
 * names, patterns, endpoints and the ownership stack. ./config.ts re-exports
 * them. They import nothing at runtime, so ./components/pr-environment.ts and
 * ./live-endpoint.ts use them without bundling the config loader.
 */

import type { ChantConfig } from "./config";

/**
 * One project-declared environment (chant #1166). Historically always a bare
 * name (`"floci"`); an entry can now instead carry the endpoint that
 * environment's `--live` reads should target (`{ name: "floci", endpoint:
 * "http://localhost:4566" }`), so a project pointed at a local emulator is
 * self-sufficient — no ambient `AWS_ENDPOINT_URL` export required to avoid
 * silently querying real AWS. See {@link environmentName}, {@link
 * environmentNames}, {@link environmentEndpoint} below, and
 * `./live-endpoint.ts`'s `applyLiveEndpoint`, the CLI-side consumer.
 *
 * The array's order is the member's promotion order (#4030, see
 * `./workspace/promotion-order.ts`), and `canary: true` marks a step as the
 * canary step of that order. The canary is declared and surfaced; chant does
 * not yet act on it.
 */
export type EnvironmentDeclaration = string | { name: string; endpoint?: string; canary?: boolean };

/**
 * `ownership.env`: a literal environment identity, or a reference to a
 * declared build parameter whose resolved value becomes the identity (#1396).
 */
export type OwnershipEnv = string | { param: string };

/** The declared name of one `environments` entry, whichever form it takes. */
export function environmentName(entry: EnvironmentDeclaration): string {
  return typeof entry === "string" ? entry : entry.name;
}

/**
 * Every declared environment's name, in `environments` order. `undefined` in,
 * `undefined` out — mirrors the field itself being optional, so a caller that
 * already writes `config.environments?.something` can keep doing so:
 * `environmentNames(config.environments)?.includes(name)`.
 */
export function environmentNames(environments: EnvironmentDeclaration[] | undefined): string[] | undefined {
  return environments?.map(environmentName);
}

/**
 * Whether a declared environment name is a glob pattern rather than a literal
 * (#1221) — it contains at least one `*`.
 */
export function isEnvironmentPattern(declaredName: string): boolean {
  return declaredName.includes("*");
}

/**
 * Anchored `*`-glob match (#1221): each `*` in `pattern` matches any run of
 * characters (possibly empty); everything else matches itself. Deliberately
 * the whole surface — no `?`, no character classes, no regex. A pattern with
 * no `*` degenerates to string equality.
 */
export function matchesEnvironmentPattern(pattern: string, name: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === name;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!name.startsWith(first)) return false;
  let cursor = first.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part === "") continue;
    const at = name.indexOf(part, cursor);
    if (at === -1) return false;
    cursor = at + part.length;
  }
  return name.length - cursor >= last.length && name.endsWith(last);
}

/**
 * Environment-membership test (#1221): is `name` covered by this project's
 * declared `environments`? A literal entry matches by equality; an entry
 * containing `*` matches as a glob pattern (`"pr-*"` covers `pr-42`).
 * Literals are checked first across the whole list, then patterns — so a
 * name that is declared outright never depends on pattern order. `undefined`
 * / empty `environments` returns `false`; callers that treat "no declared
 * environments" as "anything goes" (e.g. {@link unknownEnvError} in
 * `./env.ts`) guard that case themselves.
 */
export function matchesDeclaredEnvironment(
  environments: EnvironmentDeclaration[] | undefined,
  name: string,
): boolean {
  const names = environmentNames(environments) ?? [];
  if (names.includes(name)) return true;
  return names.some((declared) => isEnvironmentPattern(declared) && matchesEnvironmentPattern(declared, name));
}

/**
 * The endpoint `name` declares (chant #1166) — `undefined` for a bare-string
 * entry, an entry with no `endpoint` set, or a name this project doesn't
 * declare at all. `./live-endpoint.ts`'s `applyLiveEndpoint` is the consumer:
 * it injects this into the ambient env var each observing lexicon's CLI
 * shell-out reads (e.g. `AWS_ENDPOINT_URL`), unless that var is already set —
 * ambient always wins.
 *
 * A pattern entry (#1221) can carry an endpoint too: `{ name: "pr-*",
 * endpoint }` supplies the endpoint for every `pr-<n>` environment. A literal
 * entry always wins over a pattern — declaring `pr-special` alongside
 * `pr-*` resolves `pr-special` to the literal entry's endpoint (or none).
 */
export function environmentEndpoint(environments: EnvironmentDeclaration[] | undefined, name: string): string | undefined {
  const found =
    environments?.find((e) => environmentName(e) === name) ??
    environments?.find((e) => isEnvironmentPattern(environmentName(e)) && matchesEnvironmentPattern(environmentName(e), name));
  return found && typeof found !== "string" ? found.endpoint : undefined;
}

/** Whether an `ownership.env` entry is a build-parameter reference rather than a literal. */
export function isOwnershipParamRef(env: OwnershipEnv | undefined): env is { param: string } {
  return typeof env === "object" && env !== null && typeof env.param === "string";
}

/**
 * The ownership stack identity alone — `ownership.stack` when marking is on
 * (no `stack`, or `enabled: false`, means off). For callers that need the
 * stack and nothing else (a field manager, a prune selector) and so have no
 * build parameters to resolve `env` against.
 */
export function resolveOwnershipStack(config: Pick<ChantConfig, "ownership">): string | undefined {
  const o = config.ownership;
  if (!o || !o.stack || o.enabled === false) return undefined;
  return o.stack;
}
