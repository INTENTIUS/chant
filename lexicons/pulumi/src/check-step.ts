/**
 * The pulumi lexicon's steps in chant's check stage (#4633). `chant ci
 * check` runs them after the `ci.hooks.check` hooks, for each workspace
 * member of kind `pulumi` (`LexiconPlugin.checkSteps`,
 * `@intentius/chant/components/check-steps`), so a product's check
 * (`plywood check`) gets them through chant with nothing of its own:
 *
 * - `pulumi-install`: `pulumi install` (`plunge install` for a member on
 *   plunge, `./member-engine.ts`) in the member's directory, which fetches
 *   the program's dependencies and plugins the way `Pulumi.yaml` says;
 * - `stack-config`: each stack's `Pulumi.<stack>.yaml` checked against the
 *   project's config schema in `Pulumi.yaml`, with no command run (a key
 *   with a type and no default must be set, a value must read as its type,
 *   and a `secret: true` key must be encrypted). The stacks are the ones the
 *   project lists by their files, plus the member's declared stack;
 * - `pulumi-about`: `pulumi about --json`, which reports the engine, its
 *   plugins and the backend for the report.
 *
 * The argv go through `runCheckPulumi` (`./run.ts`), which refuses any
 * other. The environment is the check job's ({@link CheckStepsContext.env}):
 * no forge token, no OIDC request variables, no cloud credential, so neither
 * command can write a stack. A failure names the member and stack, and the
 * check exits with chant's `failed` code.
 *
 * The runner is injectable, so the tests run no binary.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CheckStageMember, CheckStepOutcome, CheckStepsAdapter, CheckStepsContext } from "@intentius/chant/components/check-steps";
import { parseYAML } from "@intentius/chant/yaml";
import { pulumiMemberEngine, type PulumiMemberEngine } from "./member-engine";
import { engineEnv, pulumiRunFailure, runCheckPulumi, type PulumiRunner } from "./run";

const execFileAsync = promisify(execFile);

/** The lexicon name the report carries. */
const LEXICON = "pulumi";

/** A runner for `bin` with exactly `env` (the check job's), never the process's whole environment. */
export function checkRunner(bin: PulumiMemberEngine, env: Record<string, string>): PulumiRunner {
  return (args, opts) => execFileAsync(bin, args, { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024, env: engineEnv({ ...env, ...opts.env }) });
}

// ── Stack config against the project's schema ───────────────────────

/** One key the project declares in `Pulumi.yaml`'s `config:`. */
export interface PulumiConfigKey {
  /** The full key, `<project>:<name>` for a project key. */
  key: string;
  type?: string;
  items?: { type?: string };
  secret: boolean;
  /** Whether it has a `default` or a project-level `value`. */
  hasDefault: boolean;
}

/** The project's config schema: its name, the keys it declares, and where its stack files are. */
export interface PulumiProjectSchema {
  project: string;
  keys: PulumiConfigKey[];
  /** The directory the stack files are in, relative to the project (`stackConfigDir`), or "." */
  stackConfigDir: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The key in its full form: a bare name belongs to the project. */
function fullKey(project: string, key: string): string {
  return key.includes(":") ? key : `${project}:${key}`;
}

/** Read `Pulumi.yaml`'s schema from its parsed document. A short-form entry (`key: value`) is a value with no type. */
export function pulumiProjectSchema(doc: unknown): PulumiProjectSchema {
  const d = isRecord(doc) ? doc : {};
  const project = typeof d.name === "string" ? d.name : "";
  const config = isRecord(d.config) ? d.config : {};
  const keys: PulumiConfigKey[] = [];
  for (const [name, entry] of Object.entries(config)) {
    const key = fullKey(project, name);
    const schema = isRecord(entry) && ("type" in entry || "default" in entry || "value" in entry || "secret" in entry || "description" in entry || "items" in entry);
    if (!schema) {
      keys.push({ key, secret: false, hasDefault: true });
      continue;
    }
    const e = entry as Record<string, unknown>;
    keys.push({
      key,
      ...(typeof e.type === "string" ? { type: e.type } : {}),
      ...(isRecord(e.items) && typeof e.items.type === "string" ? { items: { type: e.items.type } } : {}),
      secret: e.secret === true,
      hasDefault: "default" in e || "value" in e,
    });
  }
  return { project, keys, stackConfigDir: typeof d.stackConfigDir === "string" && d.stackConfigDir.length > 0 ? d.stackConfigDir : "." };
}

const isSecure = (v: unknown): boolean => isRecord(v) && typeof v.secure === "string";

/** Whether a scalar stack value reads as `type`. Values are strings once Pulumi reads them, so `"3"` is an integer. */
function readsAs(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    case "integer":
      return (typeof value === "number" && Number.isInteger(value)) || (typeof value === "string" && /^-?[0-9]+$/.test(value.trim()));
    case "boolean":
      return typeof value === "boolean" || value === "true" || value === "false";
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

/**
 * What is wrong with one stack's config (`config:` of its
 * `Pulumi.<stack>.yaml`, parsed) against the project's schema, as lines
 * naming the stack and key. Empty when it passes. Keys of other namespaces
 * (a provider's `aws:region`) are not checked: the project declares no type
 * for them.
 */
export function pulumiStackConfigProblems(schema: PulumiProjectSchema, stack: string, stackDoc: unknown): string[] {
  const raw = isRecord(stackDoc) && isRecord(stackDoc.config) ? stackDoc.config : {};
  const values = new Map<string, unknown>();
  for (const [k, v] of Object.entries(raw)) values.set(fullKey(schema.project, k), v);
  const problems: string[] = [];
  for (const k of schema.keys) {
    if (!k.type && !k.secret) continue;
    if (!values.has(k.key)) {
      if (k.type && !k.hasDefault) problems.push(`stack ${stack} is missing the configuration value ${k.key} (type ${k.type}, no default)`);
      continue;
    }
    const value = values.get(k.key);
    if (k.secret && !isSecure(value)) {
      problems.push(`stack ${stack} sets ${k.key} in plain text, and the project declares it secret; set it with pulumi config set --secret`);
      continue;
    }
    if (isSecure(value) || !k.type) continue;
    if (!readsAs(k.type, value)) {
      problems.push(`stack ${stack} sets ${k.key} to ${JSON.stringify(value)}, which is not of type ${k.type}`);
      continue;
    }
    if (k.type === "array" && k.items?.type && Array.isArray(value)) {
      const bad = value.findIndex((item) => !isSecure(item) && !readsAs(k.items!.type!, item));
      if (bad >= 0) problems.push(`stack ${stack} sets ${k.key}[${bad}] to ${JSON.stringify(value[bad])}, which is not of type ${k.items.type}`);
    }
  }
  return problems;
}

/** The project's file in `dir`, `Pulumi.yaml` or `Pulumi.yml`. */
function projectFile(dir: string): string | undefined {
  return ["Pulumi.yaml", "Pulumi.yml"].map((f) => join(dir, f)).find((f) => existsSync(f));
}

/** The stacks the project lists by their `Pulumi.<stack>.yaml` files in `dir`, sorted. */
export function listedStacks(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^Pulumi\.(.+)\.ya?ml$/.exec(f)?.[1])
    .filter((s): s is string => s !== undefined)
    .sort();
}

/** The stack file for `stack` in `dir`, if there is one. */
function stackFile(dir: string, stack: string): string | undefined {
  return [`Pulumi.${stack}.yaml`, `Pulumi.${stack}.yml`].map((f) => join(dir, f)).find((f) => existsSync(f));
}

// ── pulumi about ────────────────────────────────────────────────────

/** What `pulumi about --json` reported, for the check report. */
export interface PulumiAboutDetail {
  engine: PulumiMemberEngine;
  version?: string;
  plugins: Array<{ name: string; version?: string }>;
  backend?: { name?: string; url?: string; user?: string };
}

/** Read `pulumi about --json`'s document. Undefined when it is not JSON. */
export function pulumiAboutDetail(engine: PulumiMemberEngine, stdout: string | undefined): PulumiAboutDetail | undefined {
  if (!stdout) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(doc)) return undefined;
  const cli = isRecord(doc.cli) ? doc.cli : {};
  const plugins = Array.isArray(doc.plugins)
    ? doc.plugins.filter(isRecord).map((p) => ({ name: String(p.name ?? ""), ...(typeof p.version === "string" ? { version: p.version } : {}) })).filter((p) => p.name)
    : [];
  const b = isRecord(doc.backend) ? doc.backend : undefined;
  const backend = b
    ? { ...(typeof b.name === "string" ? { name: b.name } : {}), ...(typeof b.url === "string" ? { url: b.url } : {}), ...(typeof b.user === "string" ? { user: b.user } : {}) }
    : undefined;
  return { engine, ...(typeof cli.version === "string" ? { version: cli.version } : {}), plugins, ...(backend ? { backend } : {}) };
}

// ── The steps ───────────────────────────────────────────────────────

/** The last lines of what a failed run printed, for its reason. */
function tail(text: string | undefined): string {
  const lines = (text ?? "").trim().split("\n").filter(Boolean);
  return lines.slice(-3).join(" | ");
}

export interface PulumiCheckStepsOptions {
  /** The runner for an engine, given the check job's environment. Default {@link checkRunner}. */
  runner?: (engine: PulumiMemberEngine, env: Record<string, string>) => PulumiRunner;
}

/** The steps for one member, in order: install, each stack's config, about. */
export async function pulumiMemberCheck(member: CheckStageMember, ctx: Pick<CheckStepsContext, "env" | "log">, opts: PulumiCheckStepsOptions = {}): Promise<CheckStepOutcome[]> {
  const fields = member.fields ?? {};
  const declaredEngine = fields.engine === "pulumi" || fields.engine === "plunge" ? fields.engine : undefined;
  const declaredStack = typeof fields.stack === "string" && fields.stack.length > 0 ? fields.stack : undefined;
  const { engine } = pulumiMemberEngine(member.dir, declaredEngine, { env: ctx.env });
  const run = (opts.runner ?? checkRunner)(engine, ctx.env);
  const out: CheckStepOutcome[] = [];
  const base = { lexicon: LEXICON, member: member.name };

  const file = projectFile(member.dir);
  if (!file) {
    out.push({ ...base, step: "pulumi-install", exit: 1, outcome: "failed", reason: `member ${member.name} has no Pulumi.yaml in ${member.dir}` });
    return out;
  }

  // pulumi install
  let installed = true;
  try {
    await runCheckPulumi(run, ["install"], member.dir);
    out.push({ ...base, step: "pulumi-install", exit: 0, outcome: "passed" });
  } catch (err) {
    installed = false;
    const f = pulumiRunFailure(err);
    const why = f.missingBinary ? `${engine} is not installed in the check job` : tail(f.stderr) || tail(f.stdout) || f.message;
    out.push({ ...base, step: "pulumi-install", exit: f.exitCode ?? 1, outcome: "failed", reason: `${engine} install failed for member ${member.name}: ${why}` });
  }

  // Stack config, run by nothing but this module.
  let schema: PulumiProjectSchema | undefined;
  try {
    schema = pulumiProjectSchema(parseYAML(readFileSync(file, "utf-8")));
  } catch (err) {
    out.push({ ...base, step: "stack-config", exit: 1, outcome: "failed", reason: `member ${member.name}: ${file} does not read as YAML (${err instanceof Error ? err.message : String(err)})` });
  }
  if (schema) {
    const stackDir = join(member.dir, schema.stackConfigDir);
    const stacks = [...new Set([...listedStacks(stackDir), ...(declaredStack ? [declaredStack] : [])])].sort();
    if (stacks.length === 0) out.push({ ...base, step: "stack-config", exit: 0, outcome: "skipped", reason: `member ${member.name} lists no stack (no Pulumi.<stack>.yaml in ${stackDir})` });
    for (const stack of stacks) {
      const at = stackFile(stackDir, stack);
      let doc: unknown = {};
      if (at) {
        try {
          doc = parseYAML(readFileSync(at, "utf-8"));
        } catch (err) {
          out.push({ ...base, step: "stack-config", stack, exit: 1, outcome: "failed", reason: `member ${member.name}, stack ${stack}: ${at} does not read as YAML (${err instanceof Error ? err.message : String(err)})` });
          continue;
        }
      }
      const problems = pulumiStackConfigProblems(schema, stack, doc);
      out.push(
        problems.length === 0
          ? { ...base, step: "stack-config", stack, exit: 0, outcome: "passed" }
          : { ...base, step: "stack-config", stack, exit: 1, outcome: "failed", reason: `member ${member.name}: ${problems.join("; ")}`, detail: { problems } },
      );
    }
  }

  // pulumi about --json
  if (!installed) {
    out.push({ ...base, step: "pulumi-about", exit: 0, outcome: "skipped", reason: `member ${member.name}: ${engine} install failed, so about did not run` });
    return out;
  }
  const aboutArgs = declaredStack ? ["about", "--json", "--stack", declaredStack] : ["about", "--json"];
  const stackPart = declaredStack ? { stack: declaredStack } : {};
  try {
    const { stdout } = await runCheckPulumi(run, aboutArgs, member.dir);
    const detail = pulumiAboutDetail(engine, stdout);
    out.push(
      detail
        ? { ...base, step: "pulumi-about", ...stackPart, exit: 0, outcome: "passed", detail }
        : { ...base, step: "pulumi-about", ...stackPart, exit: 1, outcome: "failed", reason: `${engine} about --json for member ${member.name} printed no JSON` },
    );
  } catch (err) {
    const f = pulumiRunFailure(err);
    // about exits non-zero when one of its reads fails (no backend login in a check job), and still prints what it read.
    const detail = pulumiAboutDetail(engine, f.stdout);
    if (detail) {
      ctx.log(`pulumi check: ${engine} about for ${member.name} exited ${f.exitCode ?? 1} and reported: ${tail(f.stderr) || "no reason"}`);
      out.push({ ...base, step: "pulumi-about", ...stackPart, exit: f.exitCode ?? 1, outcome: "passed", detail });
    } else {
      const why = f.missingBinary ? `${engine} is not installed in the check job` : tail(f.stderr) || f.message;
      out.push({ ...base, step: "pulumi-about", ...stackPart, exit: f.exitCode ?? 1, outcome: "failed", reason: `${engine} about failed for member ${member.name}${declaredStack ? `, stack ${declaredStack}` : ""}: ${why}` });
    }
  }
  return out;
}

/** The pulumi lexicon's check steps, for `LexiconPlugin.checkSteps`. */
export function pulumiCheckSteps(opts: PulumiCheckStepsOptions = {}): CheckStepsAdapter {
  return {
    lexicon: LEXICON,
    kinds: ["pulumi"],
    async run(ctx) {
      const out: CheckStepOutcome[] = [];
      for (const member of ctx.members) out.push(...(await pulumiMemberCheck(member, ctx, opts)));
      return out;
    },
  };
}
