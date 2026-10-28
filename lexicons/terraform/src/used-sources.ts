/**
 * Every module source and provider address a root uses (chant#3924), read
 * from its files before `init` downloads anything, so a product can check
 * them against an allow list (terragucci's `sources:`) or a proxy map
 * (chant#4606) in a check job.
 *
 * For a root and, with `followLocal`, each local module it calls (`./` and
 * `../`, followed down to the modules they call), it reads each `module`
 * block's `source`, each `required_providers` entry, and the providers a
 * module uses with no entry: a `provider` block, or a resource, data or
 * ephemeral block's `provider` argument or type prefix, which `init` installs
 * as `hashicorp/<name>`. In the root itself it also reads a Terragrunt unit's
 * `terraform { source }`. Files are `.tf`, `.tofu` and their `.json` forms;
 * `binary` narrows them to the set that binary reads, with OpenTofu's rule
 * that `x.tofu` hides `x.tf`.
 *
 * Each source carries its file and its block path from the root
 * (`module.a > module.b > required_providers.x`) and its normal form
 * (./registry/source-forms.ts). A local call that cannot be followed
 * (outside the project, or missing) is named in `unread`, since what it
 * uses cannot be read.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { loadHcl2json, type Hcl2Json } from "@intentius/chant/terraform/hcl2json";
import { isJsonConfigFile, jsonConfigTree, selectConfigFiles } from "./hcl/files";
import { impliedProvider, normalizeModuleSource, providerAddress, withoutQuery, type SourceBinary } from "./registry/source-forms";

/** One module source or provider address a root uses. */
export interface UsedSource {
  kind: "module" | "provider";
  /** The file it is written in, relative to the project, `/`-separated. */
  file: string;
  /**
   * The block that names it, after the module calls that reach it:
   * `module.vpc`, `terraform` for a terragrunt.hcl's source,
   * `required_providers.aws`, or `provider.aws` for an implied one.
   */
  block: string;
  /** The source or address as written (`hashicorp/<name>` for an implied provider). */
  source: string;
  /**
   * The normal form: for a module, the source without its query, normalised
   * ({@link normalizeModuleSource}); for a provider, `<host>/<namespace>/<type>`
   * ({@link providerAddress}), or the source as written when it is not an address.
   */
  normal: string;
  /** For an implied provider: the block that implies it. */
  implied?: string;
}

/** A local module call that could not be followed. */
export interface UnreadSource {
  file: string;
  block: string;
  source: string;
  why: string;
}

export interface UsedSourcesOptions {
  /** Follow `./` and `../` module calls down the tree. Default true. */
  followLocal?: boolean;
  /** The project's top: file paths are relative to it, and a call that leaves it is not followed. Default the root's directory. */
  project?: string;
  /** Read only the files this binary reads, and default provider hosts to its registry. Default: every `.tf` and `.tofu` file, Terraform's registry. */
  binary?: SourceBinary;
  /** The HCL parser. Default: core's lazily loaded hcl2json. */
  parser?: Hcl2Json;
}

type Tree = Record<string, unknown>;

/** A block list as hcl2json writes it (an array) or a JSON file may (one object). */
const bodies = (v: unknown): Tree[] => (Array.isArray(v) ? (v as Tree[]) : v && typeof v === "object" ? [v as Tree] : []);

const ALL_SUFFIXES = [".tf", ".tofu", ".tf.json", ".tofu.json"];

/** The configuration files of one module directory, plus terragrunt.hcl when `terragrunt`. */
function moduleFiles(dir: string, terragrunt: boolean, binary: SourceBinary | undefined): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const names = readdirSync(dir).filter((n) => {
    try {
      return statSync(join(dir, n)).isFile();
    } catch {
      return false;
    }
  });
  const config = binary ? selectConfigFiles(names, binary) : names.filter((n) => ALL_SUFFIXES.some((s) => n.endsWith(s))).sort();
  return terragrunt && names.includes("terragrunt.hcl") ? [...config, "terragrunt.hcl"] : config;
}

/** The local name of the provider a resource, data or ephemeral block uses: its `provider` argument's, else its type's prefix. */
function providerOf(type: string, body: Tree): string {
  const ref = typeof body.provider === "string" ? /^(?:\$\{)?([A-Za-z][A-Za-z0-9_-]*)/.exec(body.provider) : null;
  return ref ? ref[1]! : type.split("_")[0]!;
}

const isLocal = (source: string): boolean => /^\.\.?\//.test(source);

interface DirRead {
  providers: UsedSource[];
  calls: { file: string; block: string; source: string }[];
}

async function readDir(abs: string, shown: string, prefix: string, top: boolean, o: Required<Pick<UsedSourcesOptions, "parser">> & UsedSourcesOptions): Promise<DirRead> {
  const providers: UsedSource[] = [];
  const calls: DirRead["calls"] = [];
  const declared = new Set<string>();
  const implied = new Map<string, { file: string; what: string }>();
  const provider = (file: string, block: string, source: string, what?: string): UsedSource => ({
    kind: "provider",
    file,
    block,
    source,
    normal: providerAddress(source, o.binary) ?? source.trim().toLowerCase(),
    ...(what ? { implied: what } : {}),
  });
  for (const name of moduleFiles(abs, top, o.binary)) {
    const file = shown === "." ? name : posix.join(shown, name);
    const text = readFileSync(join(abs, name), "utf-8");
    let tree: Tree;
    try {
      tree = (isJsonConfigFile(name) ? jsonConfigTree(text) : await o.parser.parse(file, text)) as Tree;
    } catch (e) {
      throw new Error(`${file} could not be read (${(e as Error).message.split("\n")[0]}), so its module and provider sources are unknown`);
    }
    if (name === "terragrunt.hcl") {
      for (const b of bodies(tree.terraform)) if (typeof b.source === "string") calls.push({ file, block: `${prefix}terraform`, source: b.source });
      continue;
    }
    for (const [call, list] of Object.entries((tree.module as Tree | undefined) ?? {})) {
      for (const b of bodies(list)) if (typeof b.source === "string") calls.push({ file, block: `${prefix}module.${call}`, source: b.source });
    }
    for (const t of bodies(tree.terraform)) {
      for (const req of bodies(t.required_providers)) {
        for (const [local, v] of Object.entries(req)) {
          declared.add(local);
          const source = v && typeof v === "object" && typeof (v as Tree).source === "string" ? ((v as Tree).source as string) : `hashicorp/${local}`;
          providers.push(provider(file, `${prefix}required_providers.${local}`, source));
        }
      }
    }
    for (const local of Object.keys((tree.provider as Tree | undefined) ?? {})) if (!implied.has(local)) implied.set(local, { file, what: `provider "${local}"` });
    for (const kind of ["resource", "data", "ephemeral"]) {
      for (const [type, named] of Object.entries((tree[kind] as Tree | undefined) ?? {})) {
        for (const [name, list] of Object.entries((named as Tree) ?? {})) {
          for (const b of bodies(list)) {
            const local = providerOf(type, b);
            if (!implied.has(local)) implied.set(local, { file, what: `${kind} "${type}" "${name}"` });
          }
        }
      }
    }
  }
  for (const [local, at] of implied) {
    const source = declared.has(local) ? undefined : impliedProvider(local);
    if (source) providers.push(provider(at.file, `${prefix}provider.${local}`, source, at.what));
  }
  return { providers, calls };
}

/**
 * Every module source and provider address the root at `dir` uses, and each
 * local call that could not be followed. Throws, naming the file, when a
 * file cannot be parsed, so a check fails loudly instead of checking less.
 */
export async function usedSources(dir: string, options: UsedSourcesOptions = {}): Promise<{ used: UsedSource[]; unread: UnreadSource[] }> {
  const project = options.project ?? dir;
  const o = { ...options, parser: options.parser ?? (await loadHcl2json()) };
  const follow = options.followLocal !== false;
  const used: UsedSource[] = [];
  const unread: UnreadSource[] = [];
  const shownOf = (abs: string) => relative(project, abs).split(sep).join("/") || ".";

  const walk = async (rel: string, prefix: string, chain: string[], top: boolean): Promise<void> => {
    const { providers, calls } = await readDir(join(project, rel), rel, prefix, top, o);
    used.push(...providers);
    for (const c of calls) {
      used.push({ kind: "module", file: c.file, block: c.block, source: c.source, normal: isLocal(c.source) ? withoutQuery(c.source) : normalizeModuleSource(withoutQuery(c.source), o.binary) });
      if (!follow || !isLocal(c.source)) continue;
      // A Terragrunt source's `//` marks the directory it copies; the module is the path with it read as one `/`.
      const path = withoutQuery(c.source).replace(/\/\/+/g, "/");
      const next = posix.normalize(posix.join(rel, path)).replace(/\/+$/, "") || ".";
      if (next === ".." || next.startsWith("../")) {
        unread.push({ file: c.file, block: c.block, source: c.source, why: "it is outside the project, so the sources it uses cannot be read" });
        continue;
      }
      if (!existsSync(join(project, next))) {
        unread.push({ file: c.file, block: c.block, source: c.source, why: `${next} does not exist, so the sources it uses cannot be read` });
        continue;
      }
      if (chain.includes(next) || moduleFiles(join(project, next), false, o.binary).length === 0) continue;
      await walk(next, `${c.block} > `, [...chain, next], false);
    }
  };

  const start = shownOf(dir);
  if (start === ".." || start.startsWith("../")) throw new Error(`${dir} is outside the project ${project}`);
  await walk(start, "", [start], true);
  return { used, unread };
}
