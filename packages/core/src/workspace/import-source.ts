/**
 * `chant workspace init --from tfc|spacelift|backstage` (#3178): propose a
 * declaration from structure that lives outside the repository.
 *
 * Each source is read into a small input document (see the `*Input` types),
 * and the mapping from that document to a proposal is a pure function. The
 * Terraform Cloud and Spacelift documents come from their APIs
 * (`import-fetch.ts`) or from an exported file given with `--input`; tests
 * feed fixture JSON and never open a connection. Backstage is read from
 * `catalog-info.yaml` files on disk.
 *
 * What maps:
 *
 * - a TFC workspace or a Spacelift stack becomes a member (`terraform` for a
 *   Terraform stack, `other` with a `because` for anything else);
 * - a TFC run trigger, or a Spacelift stack dependency, becomes a link on the
 *   consumer to an output of the producer;
 * - an environment is read from the `env:` or `environment:` tag or label, or
 *   the Backstage `spec.lifecycle`;
 * - policy sets and policies become constraint records;
 * - a Backstage component or resource becomes an `other` member, and its
 *   `dependsOn` becomes links.
 *
 * Everything else is listed in `leftOut`, with the reason, so the user sees
 * what the import did not carry.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import yaml from "js-yaml";
import { NAME_PATTERN, parseDeclaration } from "./declaration";
import { sanitizeName } from "./init";

export const IMPORT_SOURCES = ["tfc", "spacelift", "backstage"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** The output every imported producer exposes when its source names none: "this member was applied". */
export const APPLIED_OUTPUT = "applied";
/** The output a Backstage entity exposes to the entities that depend on it. */
export const CATALOG_OUTPUT = "catalog";

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface TfcInput {
  organization: string;
  projects?: { id: string; name: string }[];
  workspaces: {
    id: string;
    name: string;
    project?: string;
    workingDirectory?: string;
    terraformVersion?: string;
    vcsRepo?: string;
    tags?: string[];
    variables?: { key: string; category?: string; sensitive?: boolean }[];
    /** Workspace ids (or names) whose runs trigger this one. */
    runTriggers?: string[];
    notifications?: number;
  }[];
  policySets?: { id?: string; name: string; kind?: string; enforcement?: string; workspaces?: string[]; global?: boolean }[];
}

export interface SpaceliftInput {
  account: string;
  stacks: {
    id: string;
    name: string;
    space?: string;
    repository?: string;
    branch?: string;
    projectRoot?: string;
    vendor?: string;
    labels?: string[];
    dependsOn?: { stack: string; references?: { outputName: string; inputName?: string }[] }[];
    policies?: string[];
    contexts?: string[];
  }[];
  policies?: { id: string; name: string; type?: string }[];
}

// ── Result ───────────────────────────────────────────────────────────────────

export interface ImportedMember {
  name: string;
  dir: string;
  kind: string;
  because?: string;
  outputs?: string[];
  links?: { member: string; output: string }[];
}

export interface ConstraintRecord {
  id: string;
  kind: "constraint";
  source: ImportSource;
  title: string;
  policyKind?: string;
  enforcement?: string;
  /** The members the constraint applies to; empty means all of them. */
  appliesTo: string[];
}

export interface EnvironmentRecord {
  name: string;
  members: string[];
}

export interface LeftOut {
  what: string;
  count: number;
  why: string;
}

export interface ImportProposal {
  source: ImportSource;
  declaration: { name: string; schema: 1; members: ImportedMember[] };
  environments: EnvironmentRecord[];
  records: ConstraintRecord[];
  leftOut: LeftOut[];
  /** Plain-language notes the user should read before writing, such as the kind pin the proposal needs. */
  notes: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function nameFor(raw: string, taken: Set<string>): string {
  let base = sanitizeName(raw) || "member";
  if (!NAME_PATTERN.test(base)) base = "member";
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 36)}-${i}`;
  taken.add(name);
  return name;
}

function cleanDir(raw: string | undefined, fallback: string): string {
  const d = (raw ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (d === "" || d === "." || d.startsWith("/") || d.split("/").includes("..")) return fallback;
  return d;
}

const ENV_TAG = /^(?:env|environment)[:=](.+)$/i;
function envOf(tags: string[] | undefined): string[] {
  return (tags ?? []).map((t) => ENV_TAG.exec(t)?.[1]?.trim()).filter((e): e is string => !!e);
}

function addEnv(map: Map<string, string[]>, env: string, member: string): void {
  const list = map.get(env) ?? [];
  if (!list.includes(member)) list.push(member);
  map.set(env, list);
}

function envList(map: Map<string, string[]>): EnvironmentRecord[] {
  return [...map].map(([name, members]) => ({ name, members })).sort((a, b) => a.name.localeCompare(b.name));
}

function addLink(member: ImportedMember, producer: ImportedMember, output: string): void {
  producer.outputs = [...new Set([...(producer.outputs ?? []), output])];
  member.links = [...(member.links ?? [])];
  if (!member.links.some((l) => l.member === producer.name && l.output === output)) member.links.push({ member: producer.name, output });
}

function finish(source: ImportSource, workspaceName: string, members: ImportedMember[], parts: Omit<ImportProposal, "source" | "declaration">): ImportProposal {
  const declaration = { name: nameFor(workspaceName, new Set()), schema: 1 as const, members };
  // The same check `init` makes: it must read back as a valid declaration.
  parseDeclaration(JSON.stringify(declaration), "chant.workspace.json");
  return { source, declaration, ...parts };
}

const TF_NOTE =
  "Members of kind terraform get their kind from @intentius/chant-lexicon-terraform: pin that package in the declaration's pins before chant workspace check will read them.";

// ── Terraform Cloud ──────────────────────────────────────────────────────────

export function proposeFromTfc(input: TfcInput, options: { name?: string } = {}): ImportProposal {
  const taken = new Set<string>();
  const byRef = new Map<string, ImportedMember>();
  const members: ImportedMember[] = [];
  const projects = new Map((input.projects ?? []).map((p) => [p.id, p.name]));
  const envs = new Map<string, string[]>();
  let variables = 0;
  let sensitive = 0;
  let vcs = 0;
  let notifications = 0;

  for (const w of input.workspaces) {
    const name = nameFor(w.name, taken);
    const project = w.project ? projects.get(w.project) : undefined;
    const m: ImportedMember = {
      name,
      dir: cleanDir(w.workingDirectory, name),
      kind: "terraform",
      because: `Terraform Cloud workspace ${input.organization}/${w.name}${project ? ` in project ${project}` : ""}`,
    };
    members.push(m);
    byRef.set(w.id, m);
    byRef.set(w.name, m);
    for (const e of envOf(w.tags)) addEnv(envs, e, name);
    variables += w.variables?.length ?? 0;
    sensitive += (w.variables ?? []).filter((v) => v.sensitive).length;
    if (w.vcsRepo) vcs++;
    notifications += w.notifications ?? 0;
  }

  let triggers = 0;
  let dangling = 0;
  for (const w of input.workspaces) {
    const consumer = byRef.get(w.id)!;
    for (const src of w.runTriggers ?? []) {
      const producer = byRef.get(src);
      if (!producer || producer === consumer) {
        dangling++;
        continue;
      }
      addLink(consumer, producer, APPLIED_OUTPUT);
      triggers++;
    }
  }

  const records: ConstraintRecord[] = (input.policySets ?? []).map((p, i) => ({
    id: `tfc-policy-${sanitizeName(p.name) || i}`,
    kind: "constraint",
    source: "tfc",
    title: p.name,
    ...(p.kind ? { policyKind: p.kind } : {}),
    ...(p.enforcement ? { enforcement: p.enforcement } : {}),
    appliesTo: p.global ? [] : (p.workspaces ?? []).map((r) => byRef.get(r)?.name).filter((n): n is string => !!n),
  }));

  const leftOut: LeftOut[] = [];
  if (variables > 0) leftOut.push({ what: "variables", count: variables, why: `${sensitive} are sensitive and their values are never read; the keys stay in Terraform Cloud` });
  if (vcs > 0) leftOut.push({ what: "VCS connections", count: vcs, why: "the repository link belongs to the CI that replaces Terraform Cloud's runs" });
  if (notifications > 0) leftOut.push({ what: "notification configurations", count: notifications, why: "a workspace has no notification record" });
  if (dangling > 0) leftOut.push({ what: "run triggers", count: dangling, why: "their source workspace is not in the input, or is the workspace itself" });
  if ((input.projects ?? []).length > 0) leftOut.push({ what: "projects", count: input.projects!.length, why: "named in each member's because; a project is not a declared grouping" });
  leftOut.push({ what: "state and run history", count: input.workspaces.length, why: "state is adopted when a member is promoted, not copied by init" });
  void triggers;

  return finish("tfc", options.name ?? input.organization, members, { environments: envList(envs), records, leftOut, notes: [TF_NOTE] });
}

// ── Spacelift ────────────────────────────────────────────────────────────────

export function proposeFromSpacelift(input: SpaceliftInput, options: { name?: string } = {}): ImportProposal {
  const taken = new Set<string>();
  const byRef = new Map<string, ImportedMember>();
  const members: ImportedMember[] = [];
  const envs = new Map<string, string[]>();
  let nonTerraform = 0;
  let contexts = 0;

  for (const s of input.stacks) {
    const name = nameFor(s.name, taken);
    const vendor = (s.vendor ?? "terraform").toLowerCase();
    const tf = vendor === "terraform" || vendor === "opentofu";
    if (!tf) nonTerraform++;
    const m: ImportedMember = {
      name,
      dir: cleanDir(s.projectRoot, name),
      kind: tf ? "terraform" : "other",
      because: `Spacelift stack ${s.id}${s.space ? ` in space ${s.space}` : ""}${tf ? "" : `, ${vendor}`}`,
    };
    members.push(m);
    byRef.set(s.id, m);
    byRef.set(s.name, m);
    for (const e of envOf(s.labels)) addEnv(envs, e, name);
    contexts += s.contexts?.length ?? 0;
  }

  let dangling = 0;
  for (const s of input.stacks) {
    const consumer = byRef.get(s.id)!;
    for (const dep of s.dependsOn ?? []) {
      const producer = byRef.get(dep.stack);
      if (!producer || producer === consumer) {
        dangling++;
        continue;
      }
      const outs = (dep.references ?? []).map((r) => r.outputName);
      for (const o of outs.length > 0 ? outs : [APPLIED_OUTPUT]) addLink(consumer, producer, o);
    }
  }

  const attached = new Map<string, string[]>();
  for (const s of input.stacks) for (const p of s.policies ?? []) attached.set(p, [...(attached.get(p) ?? []), byRef.get(s.id)!.name]);
  const records: ConstraintRecord[] = (input.policies ?? []).map((p) => ({
    id: `spacelift-policy-${sanitizeName(p.name) || sanitizeName(p.id)}`,
    kind: "constraint",
    source: "spacelift",
    title: p.name,
    ...(p.type ? { policyKind: p.type } : {}),
    appliesTo: attached.get(p.id) ?? [],
  }));

  const leftOut: LeftOut[] = [];
  if (contexts > 0) leftOut.push({ what: "context attachments", count: contexts, why: "contexts hold variables and mounted files, which are never read" });
  if (dangling > 0) leftOut.push({ what: "stack dependencies", count: dangling, why: "the dependency's stack is not in the input, or is the stack itself" });
  if (nonTerraform > 0) leftOut.push({ what: "non-Terraform stacks kept as other", count: nonTerraform, why: "only Terraform and OpenTofu stacks take the terraform kind" });
  leftOut.push({ what: "worker pools, cloud integrations and run history", count: input.stacks.length, why: "not structure of the workspace" });

  return finish("spacelift", options.name ?? input.account, members, { environments: envList(envs), records, leftOut, notes: [TF_NOTE] });
}

// ── Backstage ────────────────────────────────────────────────────────────────

interface Entity {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: { lifecycle?: string; dependsOn?: unknown; consumesApis?: unknown; providesApis?: unknown; owner?: string; system?: string };
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".chant"]);

/** Every `catalog-info.yaml` under `root`, relative and `/`-separated. */
export function findCatalogFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
      } else if (e.isFile() && /^catalog-info\.ya?ml$/.test(e.name)) {
        out.push(relative(root, join(dir, e.name)).split("\\").join("/"));
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

const refKey = (kind: string, ns: string | undefined, name: string): string => `${kind.toLowerCase()}:${ns ?? "default"}/${name}`;

function asRefs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Normalize `name`, `kind:name` and `kind:ns/name` to `kind:ns/name`. */
function normalizeRef(ref: string, defaultKind: string): string {
  const m = /^(?:([A-Za-z]+):)?(?:([^/]+)\/)?(.+)$/.exec(ref.trim());
  if (!m) return ref;
  return refKey(m[1] ?? defaultKind, m[2], m[3]);
}

export function proposeFromBackstage(root: string, options: { name?: string } = {}): ImportProposal {
  const files = findCatalogFiles(root);
  const taken = new Set<string>();
  const byRef = new Map<string, ImportedMember>();
  const byDir = new Map<string, ImportedMember>();
  const members: ImportedMember[] = [];
  const entities: { entity: Entity; member?: ImportedMember; ref: string }[] = [];
  const envs = new Map<string, string[]>();
  const skipped = new Map<string, number>();
  const bump = (k: string): void => void skipped.set(k, (skipped.get(k) ?? 0) + 1);

  for (const file of files) {
    let docs: unknown[];
    try {
      docs = yaml.loadAll(readFileSync(join(root, file), "utf-8"));
    } catch {
      bump("unreadable catalog-info.yaml");
      continue;
    }
    const dir = cleanDir(dirname(file), "");
    for (const doc of docs) {
      const entity = doc as Entity;
      const kind = entity?.kind;
      const name = entity?.metadata?.name;
      if (typeof kind !== "string" || typeof name !== "string") continue;
      const ref = refKey(kind, entity.metadata?.namespace, name);
      if (kind !== "Component" && kind !== "Resource") {
        bump(kind);
        entities.push({ entity, ref });
        continue;
      }
      let member = byDir.get(dir);
      if (member) {
        // One member per directory: a second entity in the directory folds into the first.
        byRef.set(ref, member);
        bump(`${kind} sharing a directory with a member`);
      } else {
        member = {
          name: nameFor(name, taken),
          dir: dir === "" ? "." : dir,
          kind: "other",
          because: `Backstage ${kind.toLowerCase()} ${name}${entity.spec?.system ? ` of system ${entity.spec.system}` : ""}`,
        };
        members.push(member);
        byDir.set(dir, member);
        byRef.set(ref, member);
        const lifecycle = entity.spec?.lifecycle;
        if (lifecycle) addEnv(envs, lifecycle, member.name);
      }
      entities.push({ entity, member, ref });
    }
  }

  const apiProviders = new Map<string, ImportedMember>();
  for (const { entity, member } of entities) {
    if (member) for (const api of asRefs(entity.spec?.providesApis)) apiProviders.set(normalizeRef(api, "api"), member);
  }
  let dangling = 0;
  for (const { entity, member } of entities) {
    if (!member) continue;
    const wants: { producer: ImportedMember | undefined }[] = [
      ...asRefs(entity.spec?.dependsOn).map((r) => ({ producer: byRef.get(normalizeRef(r, "component")) })),
      ...asRefs(entity.spec?.consumesApis).map((r) => ({ producer: apiProviders.get(normalizeRef(r, "api")) })),
    ];
    for (const { producer } of wants) {
      if (!producer || producer === member) {
        dangling++;
        continue;
      }
      addLink(member, producer, CATALOG_OUTPUT);
    }
  }

  const leftOut: LeftOut[] = [...skipped].map(([what, count]) => ({
    what,
    count,
    why: what.includes("sharing a directory") ? "a member is one directory; its dependsOn links fold into the first entity there" : "not a unit of code or infrastructure; its owner and system stay in the catalog",
  }));
  if (dangling > 0) leftOut.push({ what: "dependsOn and consumesApis references", count: dangling, why: "they name an entity outside the files read, or the entity itself" });
  if (files.length === 0) leftOut.push({ what: "catalog-info.yaml files", count: 0, why: `none found under ${root}` });

  const wsName = options.name ?? (root.split(/[\\/]/).filter(Boolean).pop() ?? "backstage");
  return finish("backstage", wsName, members, { environments: envList(envs), records: [], leftOut, notes: [] });
}

// ── Reading an input file ────────────────────────────────────────────────────

export function readInputFile(source: "tfc" | "spacelift", path: string): TfcInput | SpaceliftInput {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  if (source === "tfc" && !Array.isArray(raw.workspaces)) throw new Error(`${path} has no "workspaces" array: it is not a Terraform Cloud export`);
  if (source === "spacelift" && !Array.isArray(raw.stacks)) throw new Error(`${path} has no "stacks" array: it is not a Spacelift export`);
  return raw as unknown as TfcInput | SpaceliftInput;
}
