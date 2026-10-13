/**
 * Mock outputs in Terragrunt waves (#3416): which plans of a wave would read
 * a dependency's `mock_outputs`, and the provisional mark a preview carries.
 *
 * A plan built on `mock_outputs` looks like a real one: Terragrunt says so in
 * one log line only, and the plan JSON holds the mock values as if they were
 * the upstream's (observed on 1.1.6). Gruntwork closed mocks in saved plans
 * as won't-fix (gruntwork-io/terragrunt#2178). So a wave is checked before it
 * is planned, and a wave that would read a mock is refused: it is not gated,
 * and the refusal names the upstream that must apply first.
 *
 * The rules follow Terragrunt's own (`pkg/config/dependency.go` at v1.1.6,
 * `getTerragruntOutputIfAppliedElseConfiguredDefault` and
 * `shouldReturnMockOutputs`). For one `dependency` block, read at `plan`:
 *
 * - `enabled = false` or `skip_outputs = true`: Terragrunt never reads the
 *   upstream, so with `mock_outputs` set the unit always reads the mock.
 * - The upstream has no outputs (`output -json` prints `{}`, as it does for
 *   a unit never applied): Terragrunt returns `mock_outputs` when they are
 *   set and allowed for `plan`, and fails otherwise. Either way the wave
 *   cannot plan on real values yet.
 * - The upstream has outputs and the block sets a merge strategy
 *   (`mock_outputs_merge_strategy_with_state`, or the older
 *   `mock_outputs_merge_with_state = true`): every mock key the real outputs
 *   lack is filled from the mock. That is a partial mock, and it counts.
 *
 * The blocks come from `terragrunt render --json`, so includes, locals and
 * expressions in `config_path` are Terragrunt's to evaluate, not chant's.
 *
 * A provisional plan is the other side: a dependent planned at PR time
 * (`dependents: plan`), before its upstream applied. It may read mocks. Its
 * change-set members carry `provisional: true`, which keeps it out of the
 * change-set digest, out of any wave's set digest and out of every group of
 * real plans, and its saved plans are never applied.
 *
 * Pure: nothing here spawns or reads files. `./run.ts` runs the commands.
 */

import type { ChangeSetPart } from "@intentius/chant/change-set";

/** One `dependency` block as `terragrunt render --json` prints it. */
export interface RenderedDependency {
  /** The block's label. */
  name: string;
  /** The upstream unit, relative to where Terragrunt runs, with `/` separators. */
  upstream: string;
  /** `mock_outputs`, when set. */
  mockOutputs?: Record<string, unknown>;
  /** `mock_outputs_allowed_terraform_commands`, when set. Unset or empty allows every command. */
  mockAllowed?: string[];
  /** `no_merge`, `shallow`, `deep_map_only` or `deep`, from either merge attribute. Unset is `no_merge`. */
  mergeStrategy?: string;
  /** `skip_outputs = true`. */
  skipOutputs?: boolean;
  /** `enabled = false`. */
  disabled?: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** `a/b/../c` to `a/c`, with `/` separators and no `./` or trailing `/`. An absolute path keeps its leading `/`. */
function normalize(path: string): string {
  const p = path.replace(/\\/g, "/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(seg);
  }
  const s = out.join("/");
  return p.startsWith("/") ? `/${s}` : s || ".";
}

const isAbsolute = (p: string): boolean => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);

/**
 * The upstream a `config_path` names, relative to where Terragrunt runs. A
 * relative path is taken from the unit's directory. An absolute one is made
 * relative to the first of `dirs` it sits under (a directory and its real
 * path, when a symlink leads to it), and kept absolute when it sits under
 * none. A path to the upstream's `terragrunt.hcl` names its directory.
 */
export function upstreamOfConfigPath(unit: string, configPath: string, dirs: string | readonly string[]): string {
  const p = configPath.replace(/\\/g, "/").replace(/(^|\/)terragrunt\.hcl$/, "");
  if (!isAbsolute(p)) return normalize(`${unit}/${p}`);
  const abs = normalize(p);
  for (const dir of typeof dirs === "string" ? [dirs] : dirs) {
    const root = normalize(dir);
    if (abs === root) return ".";
    if (abs.startsWith(`${root}/`)) return abs.slice(root.length + 1);
  }
  return abs;
}

/**
 * The `dependency` blocks of one unit, from `terragrunt render --json` run
 * in it. `unit` is the unit's path relative to where Terragrunt runs (`dirs`).
 * Throws when the output is not the rendered config.
 */
export function parseRenderedDependencies(unit: string, output: string | unknown, dirs: string | readonly string[]): RenderedDependency[] {
  const doc = typeof output === "string" ? (JSON.parse(output) as unknown) : output;
  if (!isObject(doc)) throw new Error("terragrunt render --json did not print an object");
  const blocks = isObject(doc.dependency) ? doc.dependency : {};
  const out: RenderedDependency[] = [];
  for (const [label, raw] of Object.entries(blocks)) {
    if (!isObject(raw) || typeof raw.config_path !== "string") continue;
    const allowed = Array.isArray(raw.mock_outputs_allowed_terraform_commands)
      ? raw.mock_outputs_allowed_terraform_commands.filter((c): c is string => typeof c === "string")
      : undefined;
    const strategy =
      typeof raw.mock_outputs_merge_strategy_with_state === "string"
        ? raw.mock_outputs_merge_strategy_with_state
        : raw.mock_outputs_merge_with_state === true
          ? "shallow"
          : undefined;
    out.push({
      name: typeof raw.name === "string" && raw.name ? raw.name : label,
      upstream: upstreamOfConfigPath(unit, raw.config_path, dirs),
      ...(isObject(raw.mock_outputs) ? { mockOutputs: raw.mock_outputs } : {}),
      ...(allowed ? { mockAllowed: allowed } : {}),
      ...(strategy && strategy !== "no_merge" ? { mergeStrategy: strategy } : {}),
      // render prints skip_outputs under `skip`.
      ...(raw.skip === true || raw.skip_outputs === true ? { skipOutputs: true } : {}),
      ...(raw.enabled === false ? { disabled: true } : {}),
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The outputs `output -json` prints, by name, with their values. Undefined
 * when the text holds no JSON object.
 */
export function parseTerragruntOutputs(output: string): Record<string, unknown> | undefined {
  const text = output.trim();
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
  if (!isObject(doc)) return undefined;
  return Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, isObject(v) && "value" in v ? v.value : v]));
}

/** Arguments to `terragrunt` that print one unit's outputs as JSON. */
export function terragruntOutputArgs(unit: string): string[] {
  return ["run", "--working-dir", unit, "--non-interactive", "--no-color", "--", "output", "-json"];
}

/** Arguments to `terragrunt` that print one unit's evaluated configuration as JSON. */
export function terragruntRenderArgs(unit: string): string[] {
  return ["render", "--json", "--non-interactive", "--no-color", "--working-dir", unit];
}

/** Why one dependency of a wave's unit would read `mock_outputs`. */
export type TerragruntMockReason =
  /** The upstream has no outputs: never applied, or applied with none. */
  | "no-outputs"
  /** A merge strategy fills keys the upstream's outputs lack from the mock. */
  | "partial"
  /** `skip_outputs = true` with `mock_outputs` set: the mock is always read. */
  | "skip-outputs"
  /** `enabled = false` with `mock_outputs` set: the mock is always read. */
  | "disabled";

/** One dependency of a wave's unit that would plan on mock values. */
export interface TerragruntMockRead {
  /** The wave's unit. */
  unit: string;
  /** The `dependency` block's label. */
  dependency: string;
  /** The upstream unit it names. */
  upstream: string;
  reason: TerragruntMockReason;
  /** For `partial`: the mock keys the upstream's outputs lack, as dotted paths. */
  keys?: string[];
}

/** Mock paths the real outputs lack. `shallow` compares top-level keys; the deep strategies follow nested maps. */
function missingKeys(mock: Record<string, unknown>, real: Record<string, unknown>, deep: boolean, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(mock)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (!(k in real)) out.push(path);
    else if (deep && isObject(v) && isObject(real[k])) out.push(...missingKeys(v, real[k] as Record<string, unknown>, deep, path));
  }
  return out.sort();
}

const allowsPlan = (d: RenderedDependency): boolean => !d.mockAllowed || d.mockAllowed.length === 0 || d.mockAllowed.includes("plan");

export interface TerragruntMockReadsInput {
  /** Each wave unit's `dependency` blocks, by unit. */
  dependencies: ReadonlyMap<string, readonly RenderedDependency[]>;
  /**
   * Each upstream's outputs, by unit path. `{}` for an upstream with none;
   * a missing entry is read as none.
   */
  outputs: ReadonlyMap<string, Record<string, unknown>>;
}

/**
 * Every dependency of the wave's units that would read `mock_outputs` at
 * plan, sorted by unit and dependency. Empty when the wave plans on real
 * outputs only.
 *
 * An upstream with no outputs is listed whether or not the block sets
 * mocks: without them Terragrunt fails the plan, and with them it plans on
 * fake values. Both mean the upstream must apply first.
 */
export function terragruntMockReads(input: TerragruntMockReadsInput): TerragruntMockRead[] {
  const out: TerragruntMockRead[] = [];
  for (const [unit, deps] of input.dependencies) {
    for (const d of deps) {
      const at = { unit, dependency: d.name, upstream: d.upstream };
      if (d.disabled || d.skipOutputs) {
        if (d.mockOutputs) out.push({ ...at, reason: d.disabled ? "disabled" : "skip-outputs" });
        continue;
      }
      const real = input.outputs.get(d.upstream) ?? {};
      if (Object.keys(real).length === 0) {
        out.push({ ...at, reason: "no-outputs" });
        continue;
      }
      if (d.mockOutputs && d.mergeStrategy && allowsPlan(d)) {
        const keys = missingKeys(d.mockOutputs, real, d.mergeStrategy !== "shallow");
        if (keys.length > 0) out.push({ ...at, reason: "partial", keys });
      }
    }
  }
  return out.sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : a.dependency < b.dependency ? -1 : a.dependency > b.dependency ? 1 : 0));
}

/** The upstreams a wave's `dependency` blocks read outputs from, sorted. */
export function terragruntOutputUpstreams(dependencies: ReadonlyMap<string, readonly RenderedDependency[]>): string[] {
  const out = new Set<string>();
  for (const deps of dependencies.values()) for (const d of deps) if (!d.disabled && !d.skipOutputs) out.add(d.upstream);
  return [...out].sort();
}

function readText(r: TerragruntMockRead): string {
  const at = `${r.unit} (dependency "${r.dependency}" on ${r.upstream})`;
  switch (r.reason) {
    case "no-outputs":
      return `${at}: ${r.upstream} has no outputs yet; apply ${r.upstream} first`;
    case "partial":
      return `${at}: ${r.upstream}'s outputs lack ${r.keys!.join(", ")}, which the merge strategy fills from mock_outputs; apply ${r.upstream} with those outputs first, or drop the merge strategy`;
    case "skip-outputs":
      return `${at}: skip_outputs = true with mock_outputs set always reads the mock; read the real outputs or drop mock_outputs`;
    case "disabled":
      return `${at}: enabled = false with mock_outputs set always reads the mock; enable the dependency or drop mock_outputs`;
  }
}

/** The refusal for a wave whose plans would read mocks: each unit, the upstream, and what must happen first. */
export function describeMockRefusal(reads: readonly TerragruntMockRead[]): string {
  const upstreams = [...new Set(reads.filter((r) => r.reason === "no-outputs" || r.reason === "partial").map((r) => r.upstream))].sort();
  const head =
    `this wave was not planned and is not gated: its plans would read mock_outputs, so nobody could approve them as real. ` +
    (upstreams.length > 0 ? `Apply ${upstreams.join(", ")} first, then plan the wave again.` : `Fix the dependency blocks below, then plan the wave again.`);
  return [head, ...reads.map((r) => `  ${readText(r)}`)].join("\n");
}

/**
 * The line Terragrunt logs when it hands a unit `mock_outputs` because the
 * upstream has no outputs (`dependency.go` at v1.1.6): "Config <upstream> is
 * a dependency of <unit> that has no outputs, but mock outputs provided and
 * returning those in dependency output."
 */
const MOCK_WARNING = /Config (\S+?) is a dependency of (\S+?) that has no outputs, but mock outputs provided/g;

/**
 * The units a plan log says read mocks, with the upstream each read,
 * relative to where Terragrunt ran (`dirs`, as for
 * {@link upstreamOfConfigPath}). This is the check after the fact: the check
 * before planning ({@link terragruntMockReads}) is what refuses a wave, and
 * this catches an upstream whose state went away in between.
 */
export function terragruntMockWarnings(log: string, dirs: string | readonly string[]): Array<{ unit: string; upstream: string }> {
  const seen = new Set<string>();
  const out: Array<{ unit: string; upstream: string }> = [];
  for (const m of log.matchAll(MOCK_WARNING)) {
    const unit = upstreamOfConfigPath(".", m[2]!, dirs);
    const upstream = upstreamOfConfigPath(".", m[1]!, dirs);
    const key = `${unit}\u0000${upstream}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ unit, upstream });
  }
  return out.sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : a.upstream < b.upstream ? -1 : 1));
}

/**
 * The parts with each member whose unit the plan log says read mocks turned
 * into a failed member, so a mock plan never reaches a gate.
 */
export function failMockedParts(parts: readonly ChangeSetPart[], mocked: ReadonlyArray<{ unit: string; upstream: string }>): ChangeSetPart[] {
  const by = new Map<string, string[]>();
  for (const m of mocked) by.set(m.unit, [...(by.get(m.unit) ?? []), m.upstream]);
  return parts.map((p) => {
    const ups = by.get(p.member.member);
    if (!ups) return p;
    return {
      member: {
        ...p.member,
        status: "failed" as const,
        error: `planned on mock_outputs: ${ups.join(", ")} had no outputs when Terragrunt planned it; apply ${ups.join(", ")} first`,
        planDigest: null,
      },
      entries: [],
    };
  });
}

/** The parts of a provisional plan: each member marked, so no digest or group of real plans takes it. */
export function markProvisional(parts: readonly ChangeSetPart[]): ChangeSetPart[] {
  return parts.map((p) => ({ ...p, member: { ...p.member, provisional: true as const } }));
}

/** The file a provisional plan leaves in its work directory, so its saved plans are never applied. */
export const PROVISIONAL_MARKER = "PROVISIONAL";
