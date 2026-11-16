/**
 * What a publish target tells a release train (#5165): the names it publishes
 * and needs, qualified by kind so the train can order members across target
 * kinds, and the wait before the next layer reveals.
 *
 * A name is `<kind>:<name>`, the name in the form its registry compares:
 *
 * | Kind | Name |
 * |---|---|
 * | `npm` | the package name, as written |
 * | `oci` | the repository, lowercased, with no tag or digest, and Docker Hub's `docker.io/` (and `library/`) left off |
 * | `pypi` | the project name normalized as PEP 503 does |
 * | `cargo` | the crate name, lowercased, `_` as `-` |
 * | `marketplace` | `<publisher>.<name>`, lowercased |
 * | `mcp` | the server's name in `server.json` |
 * | `forge`, `homebrew`, `index`, `tauri-updater` | where it publishes: the repository, and the formula or manifest name |
 *
 * So an MCP Registry entry that lists an npm package needs `npm:<package>`,
 * and an image an mcp entry lists is `oci:<repository>` in both.
 */

import { PublishTargetError, type PublishContextBase, type PublishDeps } from "./release-publish";

export type TrainNameKind = "npm" | "oci" | "pypi" | "cargo" | "marketplace" | "mcp" | "forge" | "homebrew" | "index" | "tauri-updater";

/** PEP 503's normalized project name. */
function pep503(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** An image reference's repository, as a train compares it: lowercased, no tag or digest, no `docker.io/` or `library/`. */
export function ociRepositoryName(ref: string): string {
  let r = ref.trim().toLowerCase();
  const at = r.indexOf("@");
  if (at >= 0) r = r.slice(0, at);
  const slash = r.lastIndexOf("/");
  const colon = r.indexOf(":", slash + 1);
  if (colon >= 0) r = r.slice(0, colon);
  r = r.replace(/^(?:https?:\/\/)?(?:index\.docker\.io|registry-1\.docker\.io|docker\.io)\//, "");
  return r.replace(/^library\//, "");
}

/** `<kind>:<name>`, the name in the form its registry compares. */
export function trainName(kind: TrainNameKind, name: string): string {
  switch (kind) {
    case "oci":
      return `oci:${ociRepositoryName(name)}`;
    case "pypi":
      return `pypi:${pep503(name)}`;
    case "cargo":
      return `cargo:${name.toLowerCase().replace(/_/g, "-")}`;
    case "marketplace":
      return `marketplace:${name.toLowerCase()}`;
    default:
      return `${kind}:${name}`;
  }
}

/** The project names a wheel or sdist's `Requires-Dist` lines need, leaving out those under an extra. */
export function pypiRequirements(metadata: ReadonlyArray<readonly [string, string]>): string[] {
  const out = new Set<string>();
  for (const [field, value] of metadata) {
    if (field.toLowerCase() !== "requires-dist") continue;
    const [spec, marker] = value.split(";", 2);
    if (marker && /\bextra\s*==/.test(marker)) continue;
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec ?? "");
    if (m) out.add(m[1]!);
  }
  return [...out];
}

/**
 * A label's version as a Python distribution's file name spells it (PEP
 * 440, loosely): `1.4.0-rc.1` is `1.4.0rc1`, `2.0.0-beta.2` is `2.0.0b2`.
 */
export function pep440Version(version: string): string {
  return version
    .toLowerCase()
    .replace(/^v/, "")
    .replace(/[-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?(\d*)/, (_m, tag: string, n: string) => `${tag === "alpha" ? "a" : tag === "beta" ? "b" : tag === "c" || tag === "pre" || tag === "preview" ? "rc" : tag}${n || "0"}`)
    .replace(/[-_]?(post|dev)[-_.]?(\d*)/g, (_m, tag: string, n: string) => `.${tag}${n || "0"}`);
}

/** The version in a wheel's or sdist's file name, or null when it names none chant can read. */
export function pypiFileVersion(file: string): { name: string; version: string } | null {
  if (file.endsWith(".whl")) {
    const parts = file.slice(0, -4).split("-");
    return parts.length >= 5 ? { name: parts[0]!, version: parts[1]! } : null;
  }
  const m = /^(.+)-([^-]+)\.(tar\.gz|zip)$/.exec(file);
  return m ? { name: m[1]!, version: m[2]! } : null;
}

/** How often a train's wait asks a destination again. */
export const TRAIN_VISIBLE_POLL_MS = 10_000;

/** How long a train waits for a destination to serve a reveal before it stops (#5165). */
export const TRAIN_VISIBLE_WAIT_MS = 15 * 60_000;

/**
 * Ask `check` until it says what the reveal published is served, every
 * {@link TRAIN_VISIBLE_POLL_MS}, with a line about once a minute; stop with
 * `code` after `capMs`. `check` returns the names still missing.
 */
export async function waitUntilServed(
  ctx: Pick<PublishContextBase, "log">,
  deps: Pick<PublishDeps, "sleep" | "now">,
  o: { what: string; code: string; check: () => Promise<string[]>; capMs?: number; fix?: string },
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const cap = o.capMs ?? TRAIN_VISIBLE_WAIT_MS;
  const start = now();
  let logged: number | undefined;
  for (;;) {
    const missing = await o.check();
    if (missing.length === 0) return;
    const waited = now() - start;
    if (waited >= cap) {
      throw new PublishTargetError(
        o.code,
        `${o.what} did not serve ${missing.join(", ")} within ${Math.round(cap / 1000)}s of the reveal, so the members that depend on it were not published`,
        o.fix ?? "It was published. Once it is served, run the publish again: it publishes nothing twice and goes on from there.",
      );
    }
    if (logged === undefined || now() - logged >= 60_000) {
      ctx.log(`waiting for ${o.what} to serve ${missing.join(", ")}${waited > 0 ? ` (${Math.round(waited / 1000)}s so far)` : ""}`);
      logged = now();
    }
    await sleep(TRAIN_VISIBLE_POLL_MS);
  }
}
