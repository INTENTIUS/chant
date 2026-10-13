/**
 * `otelcol validate` and `otelcol components` as Op steps (#3369).
 *
 * - `otelcolValidate` runs the collector binary's own `validate` over a
 *   config file. Before it does, it reads the binary's version and refuses
 *   when that is not the version chant's config types follow
 *   (`COLLECTOR_PIN`): a different collector accepts and rejects different
 *   fields, so its verdict is not about the config chant built. A step that
 *   names a `version` checks the binary against that version instead.
 * - `otelcolComponents` reads the binary's component list and refuses a
 *   config that uses a receiver, processor, exporter, connector or
 *   extension the binary was not built with: the failure a custom or core
 *   distribution gives at start, found before it starts.
 *
 * The binary is `bin`, else `$OTELCOL_BIN`, else `otelcol-contrib` on PATH.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { nonRetryableFailure } from "@intentius/chant/op";
import { COLLECTOR_PIN } from "../../define";
import { COMPONENT_KINDS, SECTION_OF, canonicalComponentType, parseComponentId, type ComponentKind } from "../../model";
import { defaultExec, type ExecRunner } from "./exec";

export interface OtelcolValidateArgs {
  /** The collector config file, relative to the working directory. */
  config: string;
  /** The collector binary. Default `$OTELCOL_BIN`, else `otelcol-contrib`. */
  bin?: string;
  /**
   * The collector version the binary must be, e.g. `v0.131.0`. Default
   * `COLLECTOR_PIN`'s version: the one chant's config types follow.
   */
  version?: string;
  /** Replaces the child process. For tests. */
  _exec?: ExecRunner;
}

export interface OtelcolValidateResult {
  config: string;
  bin: string;
  /** The binary's version, `v`-prefixed. */
  version: string;
  /** Always true: a config the binary rejects fails the step. */
  ok: boolean;
  output: string;
}

export interface OtelcolComponentsArgs {
  /** The collector config file, relative to the working directory. */
  config: string;
  /** The collector binary. Default `$OTELCOL_BIN`, else `otelcol-contrib`. */
  bin?: string;
  /** Replaces the child process. For tests. */
  _exec?: ExecRunner;
}

export interface MissingComponent {
  kind: ComponentKind;
  /** The component id as the config writes it, e.g. `spanmetrics/genai`. */
  id: string;
  type: string;
}

export interface OtelcolComponentsResult {
  config: string;
  bin: string;
  /** The binary's version from its build info, when it prints one. */
  version?: string;
  /** Components the config declares, by kind. */
  used: Record<ComponentKind, string[]>;
  /** Always empty: a config that uses a missing component fails the step. */
  missing: MissingComponent[];
}

/** The binary a step runs. */
export function otelcolBin(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return explicit ?? env.OTELCOL_BIN ?? "otelcol-contrib";
}

/** Normalise `0.130.0`, `v0.130.0` and `v0.130.0-dev` to `v0.130.0` for comparison. */
function normalizeVersion(v: string): string {
  const m = /v?(\d+\.\d+\.\d+)/.exec(v.trim());
  return m ? `v${m[1]}` : v.trim();
}

/**
 * The version `otelcol --version` prints: `otelcol-contrib version 0.130.0`.
 * Undefined when the output names none.
 */
export function parseOtelcolVersion(output: string): string | undefined {
  const m = /version\s+v?(\d+\.\d+\.\d+[^\s]*)/i.exec(output);
  return m ? `v${m[1]}` : undefined;
}

function readConfig(path: string, cwd: string): Record<string, unknown> {
  const text = readFileSync(resolve(cwd, path), "utf8");
  const value = load(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw nonRetryableFailure(`${path} is not a collector config: it does not hold a YAML mapping`, "OtelcolConfigInvalid");
  }
  return value as Record<string, unknown>;
}

async function binaryVersion(exec: ExecRunner, bin: string): Promise<string> {
  const r = await exec(bin, ["--version"], { timeoutMs: 30_000 });
  if (r.code === null) throw new Error(`could not run ${bin}: ${r.error ?? "not found"}. Install the collector or set bin or $OTELCOL_BIN.`);
  const version = parseOtelcolVersion(`${r.stdout}\n${r.stderr}`);
  if (r.code !== 0 || !version) throw new Error(`${bin} --version printed no version (exit ${r.code}): ${(r.stdout + r.stderr).trim().slice(0, 200)}`);
  return version;
}

/** Run `otelcol validate` over `config`, after checking the binary is the pinned (or the given) version. */
export async function otelcolValidate(args: OtelcolValidateArgs): Promise<OtelcolValidateResult> {
  const exec = args._exec ?? defaultExec;
  const bin = otelcolBin(args.bin);
  const want = normalizeVersion(args.version ?? COLLECTOR_PIN.version);
  const have = await binaryVersion(exec, bin);
  if (normalizeVersion(have) !== want) {
    const why = args.version
      ? `the step asks for ${want}`
      : `chant's collector config types follow ${COLLECTOR_PIN.version} (COLLECTOR_PIN); pass version to validate with another collector`;
    throw nonRetryableFailure(`${bin} is ${have}, and ${why}`, "OtelcolVersionMismatch");
  }
  // Fail on a missing or unreadable file here, with its name, rather than through the binary's message.
  readConfig(args.config, process.cwd());
  const r = await exec(bin, ["validate", `--config=${resolve(args.config)}`], { timeoutMs: 120_000 });
  const output = `${r.stdout}${r.stderr}`.trim();
  if (r.code !== 0) {
    throw nonRetryableFailure(`${bin} validate rejected ${args.config} (exit ${r.code ?? "none"}):\n${output}`, "OtelcolConfigInvalid");
  }
  return { config: args.config, bin, version: have, ok: true, output };
}

const KIND_OF_SECTION: Record<string, ComponentKind> = {
  receivers: "receiver",
  processors: "processor",
  exporters: "exporter",
  connectors: "connector",
  extensions: "extension",
};

/** What `otelcol components` lists, by kind: component type names. */
export interface OtelcolComponentList {
  version?: string;
  components: Record<ComponentKind, Set<string>>;
}

/**
 * Read `otelcol components` output. The format is YAML and marked unstable
 * upstream, so this reads what it can: each section may be a list of
 * objects with a `name` (v0.130.0), a list of plain names (older builds),
 * or a mapping keyed by name. Unknown top-level keys are ignored.
 */
export function parseComponentsOutput(text: string): OtelcolComponentList {
  let doc: unknown;
  try {
    doc = load(text);
  } catch (err) {
    throw new Error(`otelcol components printed output that is not YAML: ${(err as Error).message}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("otelcol components printed no YAML mapping");
  const d = doc as Record<string, unknown>;
  const components = Object.fromEntries(COMPONENT_KINDS.map((k) => [k, new Set<string>()])) as Record<ComponentKind, Set<string>>;
  let found = false;
  for (const [section, kind] of Object.entries(KIND_OF_SECTION)) {
    const value = d[section];
    if (value === undefined || value === null) continue;
    found = true;
    const names: unknown[] = Array.isArray(value)
      ? value.map((e) => (e && typeof e === "object" ? ((e as Record<string, unknown>).name ?? (e as Record<string, unknown>).type) : e))
      : typeof value === "object"
        ? Object.keys(value as Record<string, unknown>)
        : [];
    for (const n of names) if (typeof n === "string" && n !== "") components[kind].add(n);
  }
  if (!found) throw new Error("otelcol components listed no receivers, processors, exporters, connectors or extensions");
  const build = d.buildinfo as Record<string, unknown> | undefined;
  const v = build && (typeof build.version === "string" || typeof build.version === "number") ? String(build.version) : undefined;
  return { ...(v ? { version: normalizeVersion(v) } : {}), components };
}

/** The component ids a config declares, by kind. */
export function configComponents(config: Record<string, unknown>): Record<ComponentKind, string[]> {
  const out = Object.fromEntries(COMPONENT_KINDS.map((k) => [k, [] as string[]])) as Record<ComponentKind, string[]>;
  for (const kind of COMPONENT_KINDS) {
    const section = config[SECTION_OF[kind]];
    if (!section || typeof section !== "object" || Array.isArray(section)) continue;
    out[kind] = Object.keys(section as Record<string, unknown>);
  }
  return out;
}

/**
 * The components `used` names that `list` lacks. A renamed built-in counts
 * under either name: a binary that lists `otlp_grpc` runs a config that says
 * `otlp`, and the other way round.
 */
export function missingComponents(used: Record<ComponentKind, string[]>, list: OtelcolComponentList): MissingComponent[] {
  const missing: MissingComponent[] = [];
  for (const kind of COMPONENT_KINDS) {
    const have = list.components[kind];
    const canonicalHave = new Set([...have].map((t) => canonicalComponentType(kind, t)));
    for (const id of used[kind]) {
      const type = parseComponentId(id)?.type ?? id;
      if (have.has(type) || canonicalHave.has(canonicalComponentType(kind, type))) continue;
      missing.push({ kind, id, type });
    }
  }
  return missing;
}

/** Check `config` uses only components the binary was built with, from `otelcol components`. */
export async function otelcolComponents(args: OtelcolComponentsArgs): Promise<OtelcolComponentsResult> {
  const exec = args._exec ?? defaultExec;
  const bin = otelcolBin(args.bin);
  const config = readConfig(args.config, process.cwd());
  const r = await exec(bin, ["components"], { timeoutMs: 60_000 });
  if (r.code === null) throw new Error(`could not run ${bin}: ${r.error ?? "not found"}. Install the collector or set bin or $OTELCOL_BIN.`);
  if (r.code !== 0) throw new Error(`${bin} components exited ${r.code}: ${(r.stdout + r.stderr).trim().slice(0, 400)}`);
  const list = parseComponentsOutput(r.stdout);
  const used = configComponents(config);
  const missing = missingComponents(used, list);
  if (missing.length > 0) {
    const lines = missing.map((m) => `  ${m.kind} ${m.id}`).join("\n");
    throw nonRetryableFailure(
      `${args.config} uses ${missing.length} component(s) ${bin}${list.version ? ` ${list.version}` : ""} was not built with:\n${lines}`,
      "OtelcolComponentMissing",
    );
  }
  return { config: args.config, bin, ...(list.version ? { version: list.version } : {}), used, missing };
}
