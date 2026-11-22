/**
 * Whether a Dockerfile's bases are pinned by digest (#5457).
 *
 * A base named by tag (`FROM node:22`) is whatever the registry serves under
 * that tag on the day of the build, so two builds of the same commit can
 * start from different bytes. A base named by digest
 * (`FROM node:22@sha256:<digest>`) is the same image every time; the tag
 * beside it is for a reader and Docker ignores it.
 *
 * {@link unpinnedFroms} reads a Dockerfile's `FROM` lines and returns each
 * one that is not pinned. A `FROM` passes when it:
 *
 * - names an image with `@sha256:<64 hex>`;
 * - names an earlier stage (`FROM build`, after `FROM ... AS build`);
 * - is `scratch`, which is no image;
 * - names an `ARG` declared before the first `FROM` whose default is pinned,
 *   unless a build argument given for the build replaces it with a value
 *   that is not.
 *
 * A `FROM` that names an `ARG` with no default, or one whose value comes
 * only from the build, is reported, since nothing in the file pins it.
 *
 * The `supply-chain` workspace check (`security-image-base-unpinned`) and
 * `chant release doctor` run it on each Dockerfile `release.images` names;
 * the docker lexicon's DKRD021 runs the same rule on generated Dockerfiles.
 */

/** A `FROM` line that is not pinned by digest. */
export interface UnpinnedFrom {
  /** The line the instruction starts on, from 1. */
  line: number;
  /** The image as written, such as `node:22` or `${BASE}`. */
  image: string;
  /** The image after `ARG` defaults and build arguments, when it differs. */
  resolved?: string;
  /** Why it is not pinned, for a message. */
  why: string;
}

/** A reference pinned by digest: `<name>[:tag]@sha256:<64 hex>`. */
export const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/;

/** One instruction: its keyword, its arguments with continuations joined, and the line it starts on. */
export interface DockerfileInstruction {
  keyword: string;
  value: string;
  line: number;
}

/** The instructions of a Dockerfile, with comments and blank lines dropped and `\` continuations joined. */
export function dockerfileInstructions(text: string): DockerfileInstruction[] {
  const out: DockerfileInstruction[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const start = i;
    let raw = lines[i]!;
    i++;
    if (/^\s*(#|$)/.test(raw)) continue;
    while (/\\\s*$/.test(raw) && i < lines.length) {
      const next = lines[i]!;
      i++;
      if (/^\s*#/.test(next)) continue;
      raw = raw.replace(/\\\s*$/, " ") + next;
    }
    const m = /^\s*([A-Za-z]+)\s*(.*)$/.exec(raw);
    if (m) out.push({ keyword: m[1]!.toUpperCase(), value: m[2]!.trim(), line: start + 1 });
  }
  return out;
}

/** The image a `FROM` names and its stage name, with `--platform` and other flags dropped. */
export function fromImage(value: string): { image: string; as: string | null } {
  const words = value.split(/\s+/).filter((w) => w !== "" && !w.startsWith("--"));
  const asAt = words.findIndex((w) => w.toLowerCase() === "as");
  return { image: words[0] ?? "", as: asAt > 0 && words[asAt + 1] ? words[asAt + 1]! : null };
}

/** `$NAME`, `${NAME}` and `${NAME:-default}` in `s`, replaced from `values`; null when one has no value. */
function substitute(s: string, values: ReadonlyMap<string, string>): { text: string; missing: string | null } {
  let missing: string | null = null;
  const text = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_all, braced: string | undefined, fallback: string | undefined, bare: string | undefined) => {
    const name = (braced ?? bare)!;
    const v = values.get(name) ?? fallback;
    if (v === undefined || v === "") {
      missing ??= name;
      return "";
    }
    return v;
  });
  return { text, missing };
}

/** One `FROM` of a Dockerfile, read: what it names after `ARG` defaults, and whether that is pinned by digest. */
interface ReadFrom {
  line: number;
  image: string;
  resolved: string;
  /** Null when the `FROM` passes: pinned, an earlier stage, or `scratch`. */
  problem: Omit<UnpinnedFrom, "line"> | null;
  /** True when it names an image by digest, as opposed to a stage or `scratch`. */
  pinnedImage: boolean;
}

function readFroms(text: string, args: Readonly<Record<string, string>>): ReadFrom[] {
  const out: ReadFrom[] = [];
  const values = new Map<string, string>();
  const stages = new Set<string>();
  let seenFrom = false;
  for (const ins of dockerfileInstructions(text)) {
    if (ins.keyword === "ARG" && !seenFrom) {
      for (const decl of ins.value.split(/\s+/).filter(Boolean)) {
        const eq = decl.indexOf("=");
        const name = eq < 0 ? decl : decl.slice(0, eq);
        const value = eq < 0 ? undefined : decl.slice(eq + 1).replace(/^["']|["']$/g, "");
        const given = args[name];
        if (given !== undefined) values.set(name, given);
        else if (value !== undefined) values.set(name, value);
      }
      continue;
    }
    if (ins.keyword !== "FROM") continue;
    seenFrom = true;
    const { image, as } = fromImage(ins.value);
    const { text: resolved } = image.includes("$") ? substitute(image, values) : { text: image };
    const problem = checkFrom(image, values, stages);
    const isStage = resolved === "" || resolved.toLowerCase() === "scratch" || stages.has(resolved.toLowerCase());
    out.push({ line: ins.line, image, resolved, problem, pinnedImage: problem === null && !isStage && DIGEST_PINNED.test(resolved) });
    if (as) stages.add(as.toLowerCase());
  }
  return out;
}

/**
 * Each `FROM` of `text` that is not pinned by digest. `args` are the build
 * arguments the build passes, which replace an `ARG`'s default.
 */
export function unpinnedFroms(text: string, args: Readonly<Record<string, string>> = {}): UnpinnedFrom[] {
  return readFroms(text, args).flatMap((f) => (f.problem ? [{ line: f.line, ...f.problem }] : []));
}

/** A base image a Dockerfile names by digest (#5468). */
export interface PinnedBase {
  /** The line the instruction starts on, from 1. */
  line: number;
  /** The reference after `ARG` defaults, such as `cgr.dev/acme/node:22@sha256:...`. */
  reference: string;
  /** The repository with no tag and no digest, such as `cgr.dev/acme/node`. */
  repository: string;
  /** `sha256:<64 hex>`. */
  digest: string;
}

/**
 * Each `FROM` of `text` that names an image by digest, in file order, once
 * per image. A base not pinned, a stage and `scratch` are left out, which is
 * what {@link unpinnedFroms} reports and what a build records as its
 * dependencies. `args` are the build arguments the build passes.
 */
export function pinnedFroms(text: string, args: Readonly<Record<string, string>> = {}): PinnedBase[] {
  const seen = new Set<string>();
  const out: PinnedBase[] = [];
  for (const f of readFroms(text, args)) {
    if (!f.pinnedImage || seen.has(f.resolved)) continue;
    seen.add(f.resolved);
    const at = f.resolved.lastIndexOf("@");
    const name = f.resolved.slice(0, at);
    const lastSlash = name.lastIndexOf("/");
    const colon = name.indexOf(":", lastSlash + 1);
    out.push({ line: f.line, reference: f.resolved, repository: colon < 0 ? name : name.slice(0, colon), digest: f.resolved.slice(at + 1) });
  }
  return out;
}

/** Why one `FROM` image is not pinned, or null when it is, given the `ARG` values and the earlier stages. */
function checkFrom(image: string, values: ReadonlyMap<string, string>, stages: ReadonlySet<string>): Omit<UnpinnedFrom, "line"> | null {
  if (image === "" || image.toLowerCase() === "scratch" || stages.has(image.toLowerCase())) return null;
  const { text: resolved, missing } = image.includes("$") ? substitute(image, values) : { text: image, missing: null };
  if (missing) return { image, why: `it names the build argument ${missing}, which has no default before the first FROM, so nothing in the file pins it` };
  if (resolved.toLowerCase() === "scratch" || stages.has(resolved.toLowerCase()) || DIGEST_PINNED.test(resolved)) return null;
  return { image, ...(resolved !== image ? { resolved } : {}), why: `${resolved} is named by tag, not pinned by digest (name:tag@sha256:<digest>)` };
}
