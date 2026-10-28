/**
 * Which engine runs a Pulumi member: stock `pulumi` or plunge, its fork
 * (#4453). The rule is in `./run.ts`'s module comment, which re-exports
 * {@link pulumiMemberEngine}. It lives here, apart from the runner, so the
 * graph read (`./workspace-member.ts`, which runs nothing) can ask it too:
 * only a member on plunge has a checked-in `engine-graph.json` read (#4529).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseYAML } from "@intentius/chant/yaml";

/** What runs a Pulumi member's stack. */
export type PulumiMemberEngine = "pulumi" | "plunge";

/** Where the engine decision came from, first rule that answered. */
export type PulumiMemberEngineSource = "member-config" | "plywood.yml" | "PULUMI_BACKEND_URL" | "Pulumi.yaml" | "default";

/** Inputs beyond the member directory. All optional. */
export interface PulumiMemberEngineOptions {
  /** The job environment; defaults to `process.env`. Only `PULUMI_BACKEND_URL` is read. */
  env?: Record<string, string | undefined>;
  /** Where the search for `plywood.yml` stops (inclusive). Default: the first directory holding `.git`, else the filesystem root. */
  plywoodRoot?: string;
}

const PLUNGE_URL = /^plunge[+:]/;
const PLYWOOD_FILES = ["plywood.yml", "plywood.yaml"];

/**
 * The `engine` and `backend` keys of the nearest `plywood.yml`, looking in
 * `dir` and each parent up to the repository root. plywood passes no
 * detection of its own: the file is read here (chant#4559).
 */
export function readPlywoodEngine(dir: string, stopAt?: string): { file: string; engine?: PulumiMemberEngine; backend?: string } | undefined {
  let cur = resolve(dir);
  const stop = stopAt ? resolve(stopAt) : undefined;
  for (let depth = 0; depth < 32; depth++) {
    for (const name of PLYWOOD_FILES) {
      const file = join(cur, name);
      if (!existsSync(file)) continue;
      try {
        const doc = parseYAML(readFileSync(file, "utf-8")) as Record<string, unknown> | undefined;
        const engine = doc?.engine === "pulumi" || doc?.engine === "plunge" ? doc.engine : undefined;
        const backend = typeof doc?.backend === "string" ? doc.backend : undefined;
        return { file, engine, backend };
      } catch {
        // An unreadable plywood.yml fails plywood's own config check; here it names no engine.
        return { file };
      }
    }
    if (cur === stop || (!stop && existsSync(join(cur, ".git")))) return undefined;
    const parent = dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
  return undefined;
}

/**
 * Which engine runs the member, the rule that said so, and where it came from
 * (see `./run.ts`'s module comment). First rule that answers:
 * the member's config, `engine` (then a `plunge+` `backend`) in `plywood.yml`,
 * `PULUMI_BACKEND_URL`, `backend.url` in `Pulumi.yaml`, else pulumi.
 */
export function pulumiMemberEngine(
  dir: string,
  configured?: PulumiMemberEngine,
  opts: PulumiMemberEngineOptions = {},
): { engine: PulumiMemberEngine; because: string; source: PulumiMemberEngineSource } {
  if (configured) return { engine: configured, because: `the member's config says engine: ${configured}`, source: "member-config" };

  const plywood = readPlywoodEngine(dir, opts.plywoodRoot);
  if (plywood?.engine) {
    return { engine: plywood.engine, because: `${plywood.file} says engine: ${plywood.engine}`, source: "plywood.yml" };
  }
  if (plywood?.backend && PLUNGE_URL.test(plywood.backend)) {
    return { engine: "plunge", because: `${plywood.file} names the plunge backend ${plywood.backend}`, source: "plywood.yml" };
  }

  const envUrl = (opts.env ?? process.env).PULUMI_BACKEND_URL;
  if (envUrl && PLUNGE_URL.test(envUrl)) {
    return { engine: "plunge", because: `PULUMI_BACKEND_URL names the plunge backend ${envUrl}`, source: "PULUMI_BACKEND_URL" };
  }

  const file = join(dir, "Pulumi.yaml");
  if (existsSync(file)) {
    try {
      const doc = parseYAML(readFileSync(file, "utf-8"));
      const backend = doc.backend as { url?: unknown } | undefined;
      const url = typeof backend?.url === "string" ? backend.url : undefined;
      if (url && PLUNGE_URL.test(url)) return { engine: "plunge", because: `Pulumi.yaml names the plunge backend ${url}`, source: "Pulumi.yaml" };
    } catch {
      // An unreadable Pulumi.yaml fails the member file check; here it just names no backend.
    }
  }
  return { engine: "pulumi", because: "nothing names plunge", source: "default" };
}
