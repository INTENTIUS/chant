/**
 * The composed root (chant#4441, epic #4419): the temporary root a composed
 * run plans, one `module` call per member, written into the checkout under
 * `.chant-compose/`, and every file put back once the run ends.
 *
 * Lifted from terragucci's `packages/terragucci/src/compose.ts` at c493e0e
 * (the composed root section: `writeComposedRoot`, `writeEstateRoot`,
 * `unionLock`, `liftBlock`, `rewriteJson`, `hclAttributes`, `cliVarFiles`,
 * `withoutVarFiles`, `rootVarValues`, `declaredVariables`,
 * `declaredOutputs`; `linked.ts` `refRe`, `hclValue`), taking the
 * {@link Composition} of `../compose.ts` (#4438). What changed:
 *
 * - The directory is `.chant-compose/` and the file each root gains is
 *   `chant_compose.tf`; a read becomes `var.chant_read_<label>` (#4419
 *   ruling 5).
 * - A member is a component; its root's directory is `Composition.dirs`, so a
 *   module's `source` is that directory relative to the composed root.
 * - A root's var files are `terraform.roots.<name>.varFiles` as well as its
 *   tfvars, auto tfvars and `TF_CLI_ARGS` `-var-file`s, and its step's
 *   `vars` win over all of them, as `-var` does today.
 * - A `stackOutput()` in a member's `vars` that names another member becomes
 *   `module.<upstream>.<output>`; one that names a component outside the
 *   group stays the literal value the step would pass.
 * - A write that throws partway puts back what it changed before it throws,
 *   and each root file is kept as bytes, so `restore()` leaves it identical.
 *
 * While a root is composed its `backend` block, its `terraform_remote_state`
 * blocks that read another member, and its `import` and `removed` blocks are
 * cut from its files. `moved` blocks stay: a module takes them.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveWiring, type DriverComponent, type DriverPhase, type DriverStep } from "@intentius/chant/components/driver";
import type { Composition } from "../compose";
import type { TerraformConfig } from "../config";
import { blankComments, blockBody, jsonBlocks, relPath, rootTexts, type RootText } from "./hcl";

/** Where the composed root is written, in the checkout (#4419 ruling 5). */
export const COMPOSE_DIR = ".chant-compose";
/** The file a composed run adds to each root it composes, declaring the variables its reads become. */
export const COMPOSE_FILE = "chant_compose.tf";
/** The prefix of the variable a member's read of another member becomes. */
export const READ_VAR_PREFIX = "chant_read_";

const HEADER = "# Written by chant for a composed run (terraform.compose), and removed once it ends.\n";

// ── HCL text ──────────────────────────────────────────────────────────────

/** The end (exclusive) of the expression that starts at `i`: to the end of its line, or further while a bracket or a string is open. */
function exprEnd(text: string, i: number): number {
  let depth = 0;
  let inString = false;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (c === "\n" && depth === 0) return i;
  }
  return i;
}

/** The top-level `name = expression` attributes of an HCL attribute file (a `.tfvars`), comments blanked. */
export function hclAttributes(text: string): Map<string, string> {
  const t = blankComments(text);
  const out = new Map<string, string>();
  const re = /(^|\n)[ \t]*([A-Za-z_][\w-]*)[ \t]*=(?!=)/g;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const start = m.index + m[0].length;
    const end = exprEnd(t, start);
    out.set(m[2]!, t.slice(start, end).trim());
    re.lastIndex = end;
  }
  return out;
}

/** A known string as an HCL quoted string: JSON's escapes, and `${` and `%{` escaped so nothing in it is a template. */
function hclString(s: string): string {
  return JSON.stringify(s).replace(/\$\{/g, () => "$${").replace(/%\{/g, () => "%%{");
}

/** A JSON value as an HCL expression. */
export function hclValue(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(hclValue).join(", ")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{ ${keys.map((k) => `${hclString(k)} = ${hclValue((value as Record<string, unknown>)[k])}`).join(", ")} }`;
  }
  if (typeof value === "string") return hclString(value);
  return JSON.stringify(value);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A reference to the `terraform_remote_state` block `name`, not to one whose label starts with it. */
export const refRe = (name: string, flags = "g"): RegExp => new RegExp(`\\bdata\\.terraform_remote_state\\.${escapeRe(name)}(?![\\w-])`, flags);

/** A root's declared variables: the type expression and whether it is sensitive. */
export function declaredVariables(texts: readonly Pick<RootText, "text" | "json">[]): Map<string, { type?: string; sensitive: boolean }> {
  const out = new Map<string, { type?: string; sensitive: boolean }>();
  for (const t of texts) {
    if (t.json) {
      try {
        const v = (JSON.parse(t.text) as { variable?: Record<string, { type?: unknown; sensitive?: unknown }> }).variable ?? {};
        for (const [name, body] of Object.entries(v)) {
          const b = Array.isArray(body) ? body[0] : body;
          out.set(name, { ...(typeof b?.type === "string" ? { type: b.type.replace(/^\$\{(.*)\}$/, "$1") } : {}), sensitive: b?.sensitive === true });
        }
      } catch {
        // Not JSON the binary reads either; its plan says so.
      }
      continue;
    }
    for (const m of t.text.matchAll(/\bvariable\s+"([^"]+)"\s*\{/g)) {
      const body = blockBody(t.text, m.index!);
      const at = body.match(/(^|\n)\s*type\s*=/);
      const type = at ? body.slice(at.index! + at[0].length, exprEnd(body, at.index! + at[0].length)).trim() : undefined;
      out.set(m[1]!, { ...(type ? { type } : {}), sensitive: /(^|\n)\s*sensitive\s*=\s*true\b/.test(body) });
    }
  }
  return out;
}

/** A root's outputs and whether each is sensitive. */
export function declaredOutputs(texts: readonly Pick<RootText, "text" | "json">[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const t of texts) {
    if (t.json) {
      try {
        const o = (JSON.parse(t.text) as { output?: Record<string, { sensitive?: unknown }> }).output ?? {};
        for (const [name, body] of Object.entries(o)) out.set(name, (Array.isArray(body) ? body[0] : body)?.sensitive === true);
      } catch {
        // As above.
      }
      continue;
    }
    for (const m of t.text.matchAll(/\boutput\s+"([^"]+)"\s*\{/g)) out.set(m[1]!, /(^|\n)\s*sensitive\s*=\s*true\b/.test(blockBody(t.text, m.index!)));
  }
  return out;
}

// ── variable values ───────────────────────────────────────────────────────

/** The `-var-file` paths `TF_CLI_ARGS` and `TF_CLI_ARGS_plan` name, as the binary reads them, relative to the root. */
export function cliVarFiles(env: NodeJS.ProcessEnv): string[] {
  const s = `${env.TF_CLI_ARGS ?? ""} ${env.TF_CLI_ARGS_plan ?? ""}`;
  return [...s.matchAll(/(?:^|\s)-{1,2}var-file(?:=|\s+)("([^"]*)"|'([^']*)'|(\S+))/g)].map((m) => m[2] ?? m[3] ?? m[4]!).filter(Boolean);
}

/** `env` with the `-var-file` flags taken out of `TF_CLI_ARGS` and `TF_CLI_ARGS_plan`: the composed run passes those files' values as module arguments. */
export function withoutVarFiles(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of ["TF_CLI_ARGS", "TF_CLI_ARGS_plan"]) {
    if (out[k] === undefined) continue;
    out[k] = out[k]!.replace(/(?:^|\s)-{1,2}var-file(?:=|\s+)("[^"]*"|'[^']*'|\S+)/g, "").trim();
  }
  return out;
}

/**
 * A root's variable values as the binary would read them, by name, each an
 * HCL expression: its tfvars files, its auto tfvars files, the `TF_CLI_ARGS`
 * `-var-file`s, then `varFiles` (the `-var-file`s chant passes), later over
 * earlier.
 */
export function rootVarValues(dir: string, env: NodeJS.ProcessEnv, varFiles: readonly string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile());
  } catch {
    return out;
  }
  const files = [
    ...["terraform.tfvars", "terraform.tfvars.json"].filter((n) => names.includes(n)),
    ...names.filter((n) => n.endsWith(".auto.tfvars") || n.endsWith(".auto.tfvars.json")).sort(),
    ...cliVarFiles(env),
    ...varFiles,
  ];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(resolve(dir, f), "utf-8");
    } catch {
      continue;
    }
    if (f.endsWith(".json")) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(text) as Record<string, unknown>)) out.set(k, hclValue(v));
      } catch {
        // The binary would refuse it too; the plan says so.
      }
    } else {
      for (const [k, v] of hclAttributes(text)) out.set(k, v);
    }
  }
  return out;
}

/** `module.<m>.<output>`, each part of a dotted output a traversal, or an index when it is no identifier. */
function moduleRef(module: string, output: string): string {
  return `module.${module}${output
    .split(".")
    .map((p) => (/^[A-Za-z_][\w-]*$/.test(p) ? `.${p}` : `[${hclString(p)}]`))
    .join("")}`;
}

/**
 * A step's `vars` value as a module argument: a `stackOutput()` or
 * `@<component>.publish.*` naming a member becomes a reference to that
 * member's module output; one naming any other component is resolved
 * against `componentOutputs` to the literal the step would pass. Throws when
 * such a value is not known.
 */
function varExpr(value: unknown, modules: ReadonlyMap<string, string>, componentOutputs: Record<string, Record<string, unknown>>, at: string): string {
  if (typeof value === "string") {
    const pub = value.match(/^@([a-z0-9]+(?:-[a-z0-9]+)*)\.publish\.(uri|digest|key)$/);
    if (pub && modules.has(pub[1]!)) return moduleRef(modules.get(pub[1]!)!, `publish.${pub[2]}`);
    const v = resolveWiring(value, {}, componentOutputs);
    if (v === undefined) throw new Error(`${at} reads \`${value}\`, which has no value yet`);
    return hclValue(v);
  }
  if (Array.isArray(value)) return `[${value.map((v, i) => varExpr(v, modules, componentOutputs, `${at}[${i}]`)).join(", ")}]`;
  if (value && typeof value === "object") {
    if ("stackOutput" in value) {
      const { stack, name } = (value as { stackOutput: { stack: string; name: string } }).stackOutput;
      if (modules.has(stack)) return moduleRef(modules.get(stack)!, name);
      const v = resolveWiring(value, {}, componentOutputs);
      if (v === undefined) throw new Error(`${at} reads \`${stack}.${name}\`, an output of a component outside the composed run that has no value yet`);
      return hclValue(v);
    }
    const o = value as Record<string, unknown>;
    return `{ ${Object.keys(o)
      .sort()
      .map((k) => `${hclString(k)} = ${varExpr(o[k], modules, componentOutputs, `${at}.${k}`)}`)
      .join(", ")} }`;
  }
  return hclValue(value);
}

/** Every leaf step of a deploy, in order. */
function leafSteps(phases: readonly DriverPhase[]): DriverStep[] {
  const out: DriverStep[] = [];
  const walk = (steps: DriverPhase["steps"]): void => {
    for (const s of steps) {
      if (typeof (s as DriverPhase).phase === "string" && Array.isArray((s as DriverPhase).steps)) walk((s as DriverPhase).steps);
      else out.push(s as DriverStep);
    }
  };
  for (const p of phases) walk(p.steps);
  return out;
}

/** Each member's `terraform-apply` step `vars`, as written, for {@link ComposedRootInput.vars}. */
export function memberVars(components: readonly DriverComponent[], c: Pick<Composition, "members">): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const comp of components) {
    if (!c.members.includes(comp.name)) continue;
    const vars = leafSteps(comp.deploy).find((s) => s.kind === "terraform-apply")?.vars;
    if (vars && typeof vars === "object" && !Array.isArray(vars)) out[comp.name] = vars as Record<string, unknown>;
  }
  return out;
}

// ── the composed root ─────────────────────────────────────────────────────

/** The composed root as written: what to put back, and the generated files that join its digest. */
export interface ComposedRoot {
  /** The composed root's directory, absolute. */
  dir: string;
  /** The root files rewritten while the run lasts, relative to the project, sorted. {@link restore} puts each back. */
  rewritten: string[];
  /** sha256 of each generated file, by its path relative to the project, sorted. The run binds them (#4440, #4444). */
  generated: [string, string][];
  /** Each member's outputs, by component, and whether each is sensitive. The composed root re-exports each as `<module>__<name>`. */
  outputs: Map<string, Map<string, boolean>>;
  /** Put every root file back as it was and take the generated files away. Safe to call more than once. */
  restore: () => void;
}

export interface ComposedRootInput {
  /** The checkout's root: where `chant.config.*` was loaded from. `.chant-compose/` is written here. */
  projectRoot: string;
  /** What `compositionFor` answered, with members. */
  composition: Composition;
  /** The config's `terraform` namespace: each root's `varFiles`. */
  terraform: TerraformConfig;
  /** The environment the run has: `TF_CLI_ARGS*` `-var-file`s and `TF_VAR_*` are read from it. */
  env: NodeJS.ProcessEnv;
  /** Each member's step `vars` as written, by component ({@link memberVars}). `$env.*` strings are taken as they are. */
  vars?: Readonly<Record<string, Record<string, unknown> | undefined>>;
  /** The outputs of components outside the group that a member's `vars` read. */
  componentOutputs?: Record<string, Record<string, unknown>>;
  /** How a file is written. Default `writeFileSync`; a test injects a failure here. Putting files back always uses `writeFileSync`. */
  write?: (file: string, text: string) => void;
}

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

/** Cut ranges out of a text, from the end so positions hold. */
function cut(text: string, ranges: [number, number][]): string {
  let out = text;
  for (const [a, b] of [...ranges].sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + out.slice(b);
  return out;
}

/** A module's `source`: the member's directory relative to the composed root, as a local path. */
function moduleSource(composeDir: string, dir: string): string {
  const rel = relPath(composeDir, dir);
  return JSON.stringify(rel.startsWith(".") ? rel : `./${rel}`);
}

/** The composed root's `output` blocks: each member's outputs as `<module>__<name>`. */
function reExports(c: Composition, outputs: ReadonlyMap<string, ReadonlyMap<string, boolean>>): string[] {
  return c.order.flatMap((m) =>
    [...(outputs.get(m) ?? [])].map(([o, sensitive]) => `output "${c.modules.get(m)}__${o}" {\n  value = module.${c.modules.get(m)}.${o}\n${sensitive ? "  sensitive = true\n" : ""}}\n`),
  );
}

/** Tracks what a write changed so all of it goes back. */
class Undo {
  private originals = new Map<string, Buffer>();
  private generated: string[] = [];
  private madeDir?: string;
  constructor(private readonly write: (file: string, text: string) => void) {}

  dir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      this.madeDir = dir;
    }
  }
  /** Rewrite a root file, keeping its bytes first. */
  rewrite(file: string, text: string): void {
    if (!this.originals.has(file)) this.originals.set(file, readFileSync(file));
    this.write(file, text);
  }
  /** Write a file the run generates, noted before it is written so a partial write is taken away too. */
  generate(file: string, text: string): void {
    this.generated.push(file);
    this.write(file, text);
  }
  rewritten(projectRoot: string): string[] {
    return [...this.originals.keys()].map((f) => relPath(projectRoot, f)).sort();
  }
  generatedFiles(): readonly string[] {
    return this.generated;
  }
  restore(): void {
    const errors: unknown[] = [];
    for (const [f, bytes] of this.originals) {
      try {
        writeFileSync(f, bytes);
      } catch (e) {
        errors.push(e);
      }
    }
    for (const f of this.generated) {
      try {
        rmSync(f, { force: true });
      } catch (e) {
        errors.push(e);
      }
    }
    if (this.madeDir) {
      try {
        if (readdirSync(this.madeDir).length === 0) rmdirSync(this.madeDir);
      } catch {
        // Gone already, or the run left its working files there.
      }
    }
    if (errors.length > 0) throw errors[0];
  }
}

function digests(projectRoot: string, files: readonly string[]): [string, string][] {
  return files.map((f) => [relPath(projectRoot, f), sha256(readFileSync(f))] as [string, string]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function assertComposed(c: Composition, estate: boolean): void {
  if (c.fallback || c.members.length < 2) throw new Error(`nothing composes${c.fallback ? `: ${c.fallback.reason}` : ""}`);
  if (!!c.estate !== estate) throw new Error(estate ? "the composition is not one of estates; write it with writeComposedRoot" : "the composition is one of estates; write it with writeEstateRoot");
}

/**
 * Write the composed root of `composition` into `.chant-compose/` and rewrite
 * each member: its backend block cut, its `terraform_remote_state` reads of
 * other members cut and their references turned into a variable the composed
 * root fills with `{ outputs = module.<upstream> }`, and its `import` and
 * `removed` blocks lifted into the composed root with `module.<m>.` in front
 * of their addresses. Each root's variable values, then its step's `vars`,
 * become the module's arguments. Throws, changing nothing, when a root
 * already has a `chant_compose.tf`; throws after putting everything back
 * when a write fails partway.
 */
export function writeComposedRoot(input: ComposedRootInput): ComposedRoot {
  const c = input.composition;
  assertComposed(c, false);
  const projectRoot = resolve(input.projectRoot);
  const dir = join(projectRoot, COMPOSE_DIR);
  const env = input.env;
  for (const m of c.order) {
    if (existsSync(join(c.dirs.get(m)!, COMPOSE_FILE))) throw new Error(`${relPath(projectRoot, c.dirs.get(m)!)}: ${COMPOSE_FILE} is already in the root`);
  }
  const undo = new Undo(input.write ?? ((f, t) => writeFileSync(f, t)));
  const outputs = new Map<string, Map<string, boolean>>();
  const lifted: string[] = [];
  const passed = new Map<string, { type?: string; sensitive: boolean }>();
  const modules: string[] = [];
  try {
    for (const member of c.order) {
      const m = c.modules.get(member)!;
      const rdir = c.dirs.get(member)!;
      const texts = rootTexts(rdir);
      outputs.set(member, declaredOutputs(texts));
      const variables = declaredVariables(texts);
      const remote = (c.reads.get(member) ?? []).flatMap((r) => (r.via === "remote-state" ? [{ name: r.name, upstream: r.upstream }] : []));
      for (const t of texts) {
        const raw = readFileSync(t.file, "utf-8");
        let next: string;
        if (t.json) next = rewriteJson(raw, remote, m, lifted);
        else {
          const ranges: [number, number][] = [];
          for (const b of t.text.matchAll(/\bbackend\s+"[^"]+"\s*\{/g)) ranges.push([b.index!, b.index! + blockBody(t.text, b.index!).length]);
          for (const b of t.text.matchAll(/\bdata\s+"terraform_remote_state"\s+"([^"]+)"\s*\{/g)) {
            if (remote.some((x) => x.name === b[1])) ranges.push([b.index!, b.index! + blockBody(t.text, b.index!).length]);
          }
          for (const b of t.text.matchAll(/(^|\n)([ \t]*)(import|removed)\s*\{/g)) {
            const at = b.index! + b[1]!.length;
            const body = raw.slice(at, at + blockBody(t.text, at).length);
            ranges.push([at, at + body.length]);
            lifted.push(liftBlock(body, b[3] as "import" | "removed", m));
          }
          next = cut(raw, ranges);
          for (const x of remote) next = next.replace(refRe(x.name), `var.${READ_VAR_PREFIX}${x.name}`);
        }
        if (next !== raw) undo.rewrite(t.file, next);
      }
      const readNames = [...new Set(remote.map((x) => x.name))];
      undo.generate(join(rdir, COMPOSE_FILE), `${HEADER}${readNames.map((n) => `variable "${READ_VAR_PREFIX}${n}" {\n  type = any\n}\n`).join("\n")}`);

      // Arguments: the root's variable values, then its step's vars over them, then a TF_VAR_ the job sets for a variable still without one, then its reads.
      const rootKey = c.roots.get(member)!;
      const args = new Map<string, string>();
      for (const [k, v] of rootVarValues(rdir, env, input.terraform.roots[rootKey]?.varFiles ?? [])) if (variables.has(k)) args.set(k, v);
      for (const [k, v] of Object.entries(input.vars?.[member] ?? {})) {
        if (v === undefined) continue;
        args.set(k, varExpr(v, c.modules, input.componentOutputs ?? {}, `\`${member}\`'s var \`${k}\``));
      }
      for (const [k, v] of variables) {
        if (args.has(k) || env[`TF_VAR_${k}`] === undefined) continue;
        if (!passed.has(k)) passed.set(k, v);
        args.set(k, `var.${k}`);
      }
      for (const n of readNames) args.set(`${READ_VAR_PREFIX}${n}`, `{ outputs = module.${c.modules.get(remote.find((x) => x.name === n)!.upstream)} }`);
      const lines = [`  source = ${moduleSource(dir, rdir)}`, ...[...args].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `  ${k} = ${v}`)];
      modules.push(`module "${m}" {\n${lines.join("\n")}\n}\n`);
    }
    undo.dir(dir);
    const vars = [...passed].map(([k, v]) => `variable "${k}" {\n${v.type ? `  type = ${v.type}\n` : ""}${v.sensitive ? "  sensitive = true\n" : ""}}\n`);
    undo.generate(join(dir, "main.tf"), [`${HEADER}# Each root a module, its state its own.\n`, ...vars, ...modules, ...reExports(c, outputs), ...lifted].join("\n"));
    const lock = unionLock(c.order.map((m) => c.dirs.get(m)!));
    if (lock) undo.generate(join(dir, ".terraform.lock.hcl"), lock);
  } catch (e) {
    undo.restore();
    throw e;
  }
  return { dir, rewritten: undo.rewritten(projectRoot), generated: digests(projectRoot, undo.generatedFiles()), outputs, restore: () => undo.restore() };
}

/** An `import` or `removed` block of module `m`, lifted into the composed root: its address with `module.<m>.` in front. */
export function liftBlock(body: string, kind: "import" | "removed", m: string): string {
  const key = kind === "import" ? "to" : "from";
  return `${body.replace(new RegExp(`(^|\\n)(\\s*)${key}(\\s*)=(\\s*)`), `$1$2${key}$3=$4module.${m}.`).trim()}\n`;
}

/** A JSON-syntax file rewritten as {@link writeComposedRoot} rewrites HCL: its backend, its reads of members, and its import and removed blocks out. */
export function rewriteJson(raw: string, reads: readonly { name: string }[], m: string, lifted: string[]): string {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw;
  }
  let changed = false;
  for (const t of Array.isArray(doc.terraform) ? doc.terraform : [doc.terraform]) {
    if (t && typeof t === "object" && "backend" in (t as object)) {
      delete (t as Record<string, unknown>).backend;
      changed = true;
    }
  }
  const data = doc.data as Record<string, Record<string, unknown>> | undefined;
  const rs = data?.terraform_remote_state;
  if (rs && typeof rs === "object") {
    for (const x of reads) {
      if (x.name in rs) {
        delete rs[x.name];
        changed = true;
      }
    }
    if (Object.keys(rs).length === 0) delete data!.terraform_remote_state;
    if (data && Object.keys(data).length === 0) delete doc.data;
  }
  for (const kind of ["import", "removed"] as const) {
    for (const b of jsonBlocks(doc, kind)) {
      const key = kind === "import" ? "to" : "from";
      const addr = String(b[key] ?? "").replace(/^\$\{(.*)\}$/, "$1");
      const rest =
        kind === "import" ? `  id = ${JSON.stringify(b.id)}\n` : b.lifecycle ? `  lifecycle {\n    destroy = ${(b.lifecycle as { destroy?: unknown }).destroy === false ? "false" : "true"}\n  }\n` : "";
      lifted.push(`${kind} {\n  ${key} = module.${m}.${addr}\n${rest}}\n`);
      changed = true;
    }
    if (kind in doc) delete doc[kind];
  }
  let text = changed ? JSON.stringify(doc, null, 2) + "\n" : raw;
  for (const x of reads) text = text.replace(refRe(x.name), `var.${READ_VAR_PREFIX}${x.name}`);
  return text;
}

/** The union of the roots' `.terraform.lock.hcl`: one block per provider, with every hash any root's file holds for it. */
export function unionLock(dirs: readonly string[]): string | undefined {
  const blocks = new Map<string, { version: string; constraints?: string; hashes: Set<string> }>();
  for (const d of dirs) {
    let text: string;
    try {
      text = readFileSync(join(d, ".terraform.lock.hcl"), "utf-8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/^provider\s+"([^"]+)"\s*\{/gm)) {
      const body = blockBody(text, m.index!);
      const version = body.match(/\bversion\s*=\s*"([^"]+)"/)?.[1];
      if (!version) continue;
      const constraints = body.match(/\bconstraints\s*=\s*"([^"]*)"/)?.[1];
      const hashes = [...(body.match(/\bhashes\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((h) => h[1]!);
      const had = blocks.get(m[1]!);
      if (had) for (const h of hashes) had.hashes.add(h);
      else blocks.set(m[1]!, { version, ...(constraints !== undefined ? { constraints } : {}), hashes: new Set(hashes) });
    }
  }
  if (blocks.size === 0) return undefined;
  const out = ["# Written by chant for a composed run: the union of its roots' lock files.\n"];
  for (const [p, b] of [...blocks].sort(([a], [c]) => (a < c ? -1 : 1))) {
    out.push(
      `provider "${p}" {\n  version     = "${b.version}"\n${b.constraints !== undefined ? `  constraints = "${b.constraints}"\n` : ""}  hashes = [\n${[...b.hashes]
        .sort()
        .map((h) => `    "${h}",`)
        .join("\n")}\n  ]\n}\n`,
    );
  }
  return out.join("\n");
}

/**
 * The composed root of an estate run (`Composition.estate`), written into
 * `.chant-compose/`: one `module` call per estate whose `source` is the
 * estate's own directory and nothing else, and each estate's outputs
 * re-exported as `<module>__<name>`, which is where the plan shows what an
 * estate's output will be. No estate file is changed, so `restore()` only
 * takes the generated files away. choudoufu reads each called directory's
 * own `live` block, and resolves a `terraform_estate_outputs` read of
 * another estate inside the run.
 */
export function writeEstateRoot(input: Pick<ComposedRootInput, "projectRoot" | "composition" | "write">): ComposedRoot {
  const c = input.composition;
  assertComposed(c, true);
  const projectRoot = resolve(input.projectRoot);
  const dir = join(projectRoot, COMPOSE_DIR);
  const undo = new Undo(input.write ?? ((f, t) => writeFileSync(f, t)));
  const outputs = new Map<string, Map<string, boolean>>(c.order.map((m) => [m, declaredOutputs(rootTexts(c.dirs.get(m)!))] as const));
  try {
    const modules = c.order.map((m) => `module "${c.modules.get(m)}" {\n  source = ${moduleSource(dir, c.dirs.get(m)!)}\n}\n`);
    undo.dir(dir);
    undo.generate(join(dir, "main.tf"), [`${HEADER}# Each estate's directory a module, its records its own.\n`, ...modules, ...reExports(c, outputs)].join("\n"));
    const lock = unionLock(c.order.map((m) => c.dirs.get(m)!));
    if (lock) undo.generate(join(dir, ".terraform.lock.hcl"), lock);
  } catch (e) {
    undo.restore();
    throw e;
  }
  return { dir, rewritten: [], generated: digests(projectRoot, undo.generatedFiles()), outputs, restore: () => undo.restore() };
}
