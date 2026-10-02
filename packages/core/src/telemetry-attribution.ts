/**
 * Telemetry attribution (#2558, #2524 D22, ws-060).
 *
 * A workload's spans carry resource attributes that name the declaration and
 * the release that produced them, so a reader (hud, behold) can join a span
 * back to a member, a release and a node of `chant workspace graph`. They use
 * OpenTelemetry semantic conventions where those exist and a `chant.*`
 * namespace for the rest ({@link TELEMETRY_ATTRIBUTES}).
 *
 * A lexicon that declares workloads stamps them as environment variables
 * (`OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`, which every OTel SDK
 * reads) when it builds inside a workspace. The build resolves the facts once
 * ({@link resolveTelemetryAttribution}) and hands them to each serializer on
 * `SerializeContext.telemetry`, and {@link telemetryEnvironment} turns them
 * into the variables for one workload.
 *
 * Level 0 is untouched: a project with no `chant.workspace.json` above it,
 * and no `telemetry.attribution: true` in its config, resolves to nothing and
 * its output is the same bytes as before. The workspace declaration reader is
 * imported only once a declaration has been found (#2525 rule 5, pinned by
 * #2526's goldens), and this module's name keeps it off the workspace-module
 * list.
 */

import { relative, resolve, sep } from "node:path";
import { findWorkspaceRoot } from "./project-root";

/** What a build knows about where it runs, for the attributes it can stamp. */
export interface TelemetryAttribution {
  /** The declaration's `name`, when the project is inside a workspace. */
  workspace?: string;
  /** The member that owns the project, when it is inside a workspace and a member owns it. */
  member?: string;
  /** The environment the build is for (`--env`, or the config's `ownership.env`), when it has one. */
  environment?: string;
}

/** One attribute of the table in D22, as data, so docs and tests read the same list. */
export interface TelemetryAttributeSpec {
  key: string;
  /** Where the value comes from. */
  source: string;
  /** What a reader joins it to. */
  joinsTo: string;
  /** Whether a lexicon's build stamps it. The rest are set by the release step, which knows them. */
  stampedAtBuild: boolean;
}

export const TELEMETRY_ATTRIBUTES: readonly TelemetryAttributeSpec[] = [
  { key: "service.name", source: "the declaration's name", joinsTo: "the service", stampedAtBuild: true },
  { key: "service.version", source: "the release's artifact digest", joinsTo: "the member's release ledger", stampedAtBuild: false },
  { key: "deployment.environment.name", source: "the environment", joinsTo: "the ledger's environment", stampedAtBuild: true },
  { key: "vcs.ref.head.revision", source: "the git SHA", joinsTo: "the workspace revision (D15)", stampedAtBuild: false },
  { key: "chant.workspace", source: "the workspace declaration's `name`", joinsTo: "the workspace", stampedAtBuild: true },
  { key: "chant.member", source: "the member name", joinsTo: "the member", stampedAtBuild: true },
  { key: "chant.decl", source: "the declaration id", joinsTo: "the node in `chant workspace graph`", stampedAtBuild: true },
];

/** The config's opt-in or opt-out, `telemetry.attribution`. */
function configured(config: Record<string, unknown> | undefined): boolean | undefined {
  const telemetry = config?.telemetry;
  if (typeof telemetry !== "object" || telemetry === null) return undefined;
  const value = (telemetry as { attribution?: unknown }).attribution;
  return typeof value === "boolean" ? value : undefined;
}

/**
 * What a build at `projectDir` stamps, or `undefined` for nothing.
 *
 * Inside a workspace attribution is on, and `telemetry.attribution: false`
 * turns it off. Outside one it is off, and `telemetry.attribution: true`
 * turns it on, with the attributes that need no workspace (`chant.workspace`
 * and `chant.member` are then absent).
 *
 * A declaration that can't be read stamps the workspace-free attributes only:
 * `chant workspace check` is where a broken declaration is reported, and a
 * build must not fail on it.
 */
export async function resolveTelemetryAttribution(
  projectDir: string,
  config: Record<string, unknown> | undefined,
  environment?: string,
): Promise<TelemetryAttribution | undefined> {
  const setting = configured(config);
  if (setting === false) return undefined;
  const found = findWorkspaceRoot(projectDir);
  if (!found && setting !== true) return undefined;
  const out: TelemetryAttribution = {};
  if (found) {
    // Only now does workspace code load.
    try {
      const { readDeclaration, resolveGroups, ownerOf } = await import("./workspace/declaration");
      const { workingTree } = await import("./workspace/tree");
      const tree = workingTree(found.dir);
      const declaration = readDeclaration(tree);
      out.workspace = declaration.name;
      const rel = relative(found.dir, resolve(projectDir));
      const owner = ownerOf(declaration, resolveGroups(declaration, tree), rel === "" ? "" : rel.split(sep).join("/"));
      if (owner && "member" in owner) out.member = owner.member.name;
    } catch {
      // Left to `chant workspace check`.
    }
  }
  if (environment) out.environment = environment;
  return out;
}

/** What a workload adds to the attributes: its own identity. */
export interface TelemetryWorkload {
  /** `service.name`: the workload's name in the declaration. */
  service: string;
  /** `chant.decl`: the declaration id, the graph node id inside the member. */
  decl: string;
  /** `service.version`, when the build knows the artifact digest (an image pinned by digest). */
  version?: string;
}

/** The environment variables that carry one workload's attributes. Keys the build can't fill are left out. */
export function telemetryEnvironment(attribution: TelemetryAttribution, workload: TelemetryWorkload): { OTEL_SERVICE_NAME: string; OTEL_RESOURCE_ATTRIBUTES: string } {
  const pairs: [string, string | undefined][] = [
    ["chant.workspace", attribution.workspace],
    ["chant.member", attribution.member],
    ["chant.decl", workload.decl],
    ["deployment.environment.name", attribution.environment],
    ["service.version", workload.version],
  ];
  return {
    OTEL_SERVICE_NAME: workload.service,
    OTEL_RESOURCE_ATTRIBUTES: pairs
      .filter((p): p is [string, string] => p[1] !== undefined && p[1] !== "")
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join(","),
  };
}

/**
 * Add `extra` to a resource-attributes string a project already set. A key the
 * project set keeps its value, so a team's own `chant.member` is never
 * overwritten; a key it didn't set is appended.
 */
export function mergeResourceAttributes(existing: string, extra: string): string {
  const have = new Set(existing.split(",").map((kv) => kv.split("=")[0]!.trim()).filter(Boolean));
  const added = extra.split(",").filter((kv) => kv !== "" && !have.has(kv.split("=")[0]!));
  return [existing, ...added].filter((s) => s !== "").join(",");
}
