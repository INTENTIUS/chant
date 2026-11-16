/**
 * The index-repository target (#5158): manifests in a repository on GitHub
 * that a package manager or a directory reads, rendered from templates in
 * the member, and either committed to a repository the publisher may push
 * to or proposed in a pull request on one it can't.
 *
 * Presets fill in what a known index needs (./publish-declaration.ts,
 * `INDEX_PRESETS`):
 *
 * | Preset | Repository | Mode | Manifest |
 * |---|---|---|---|
 * | `krew` | kubernetes-sigs/krew-index | pull-request | `plugins/{name}.yaml` |
 * | `winget` | microsoft/winget-pkgs | pull-request | `files`, under `manifests/{letter}/{namePath}/{version}/` |
 * | `scoop` | yours | commit | `bucket/{name}.json` |
 * | `homebrew-core` | Homebrew/homebrew-core | pull-request | `Formula/{letter}/{name}.rb` |
 * | `homebrew-tap` | yours | commit | `Formula/{name}.rb` |
 * | `zed` | zed-industries/extensions | pull-request | `version` in `extensions.toml`, and the `extensions/{name}` submodule at the release's commit |
 * | `artifacthub` | yours | commit | `{name}/{version}/artifacthub-pkg.yml` |
 *
 * The templates take the `homebrew` target's placeholders (`{{version}}`,
 * `{{label}}`, `{{tag}}`, `{{url:<asset>}}`, `{{sha256:<asset>}}`) and
 * `{{name}}` and `{{commit}}`. Each asset is one the release records, named
 * by `artifact:<name>` (#5151) or by its path, and its SHA-256 is the one the
 * release records: the file is never read or hashed again.
 *
 * `mode: "commit"` is the tap's two steps (./publish-homebrew.ts): the stage
 * commits to `chant-publish/<name>-<version>` beside the branch, and the
 * reveal fast-forwards the branch. `mode: "pull-request"` stages the same
 * commit on a branch of the publisher's fork (made when there is none), and
 * the reveal opens the pull request. A resume finds the pull request it
 * opened, open or merged, and opens none again; one the index closed without
 * merging is a refusal. An index that already holds the manifests as
 * rendered, such as one a bot updated, gets nothing.
 *
 * The target reveals last (`revealsLast`, as the MCP Registry does): it
 * stages with the other targets, onto a branch no consumer reads, and
 * reveals after every other target, since the index points at files those
 * targets make downloadable. Targets that reveal last go in the order
 * declared. A refusal is a warning unless `onRefusal: "fail"`
 * (`refusalWarns`).
 *
 * The `homebrew` target is this target's `homebrew-tap` preset with its own
 * fields, kind and codes, staged and revealed in the order declared as
 * before, its hashes read from the checkout and checked against the record.
 *
 * Status changes (#5163, `chant release yank|restore`): an index has no
 * per-version deprecation, so deprecate changes nothing. In `mode: "commit"`
 * a yank puts back each manifest as the head release (the newest active one
 * of the channel) published it, found by its digest among the last 100
 * commits of the branch that touch it, when the branch still holds this
 * release's; a manifest the head release did not publish, such as Artifact
 * Hub's `{name}/{version}/artifacthub-pkg.yml`, is removed. A restore puts
 * this release's manifests back, from the same history, where no newer
 * active release holds the path. One commit either way. In
 * `mode: "pull-request"` the index's maintainers merge what changes, so a
 * yank or restore is refused (`release-status-index-pull-request`).
 */

import { readFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { readCredential, type Credential } from "./publish-credentials";
import type { IndexPublishDeclaration } from "./publish-declaration";
import { SshGitRepo } from "./publish-git-ssh";
import { GitHubRepo, githubApi } from "./publish-github";
import { bytesDigest, checkReleaseDigest, expandArtifactAssets, memberFile, publishTargetKey, releaseArtifactAt } from "./publish-targets";
import { PublishTargetError, type PublishContext, type PublishContextBase, type PublishDeps, type PublishFetch, type PublishItem, type PublishTarget, type StagedTarget, type StatusAction, type StatusContext } from "./release-publish";
import { prereleaseOf } from "./release-prerelease";

/** The first chant that publishes an `index` target (#5158). */
export const PUBLISH_INDEX_FLOOR = "0.124.101";

/** The variable an index target reads its token from when the declaration names none. */
export const INDEX_TOKEN_ENV = "INDEX_TOKEN";

type Preset = NonNullable<IndexPublishDeclaration["preset"]>;

/** What each preset fills in. */
export const INDEX_PRESET_DEFAULTS: Readonly<Record<Preset, { repo?: string; mode: "commit" | "pull-request"; path?: string; title: string; tokenEnv?: string }>> = {
  krew: { repo: "kubernetes-sigs/krew-index", mode: "pull-request", path: "plugins/{name}.yaml", title: "Update {name} to {version}" },
  winget: { repo: "microsoft/winget-pkgs", mode: "pull-request", title: "New version: {name} version {version}" },
  scoop: { mode: "commit", path: "bucket/{name}.json", title: "{name}: Update to version {version}" },
  "homebrew-core": { repo: "Homebrew/homebrew-core", mode: "pull-request", path: "Formula/{letter}/{name}.rb", title: "{name} {version}" },
  "homebrew-tap": { mode: "commit", path: "Formula/{name}.rb", title: "{name} {version}", tokenEnv: "HOMEBREW_TAP_TOKEN" },
  zed: { repo: "zed-industries/extensions", mode: "pull-request", title: "Update {name} to {version}" },
  artifacthub: { mode: "commit", path: "{name}/{version}/artifacthub-pkg.yml", title: "{name} {version}" },
};

/** A release's version for a package manager: its label from the first digit on, or null when the label has no digit. */
export function releaseVersion(label: string | null): string | null {
  const at = label?.search(/\d/) ?? -1;
  return label && at >= 0 ? label.slice(at) : null;
}

/** `pattern` with `{tag}`, `{label}`, `{version}` and `{name}` filled in, each URL-encoded except the tag's slashes. */
export function fillUrl(pattern: string, values: { tag: string; label: string; version: string; name: string }): string {
  return pattern.replace(/\{(tag|label|version|name)\}/g, (_, k: keyof typeof values) =>
    k === "tag" ? values.tag.split("/").map(encodeURIComponent).join("/") : encodeURIComponent(values[k]),
  );
}

/** Render a manifest template with `values` (each `{{key}}`) and each asset's `{{url:<name>}}` and `{{sha256:<name>}}`, or name what it can't fill, refused with `code`. */
export function renderManifest(template: string, values: Readonly<Record<string, string>>, assets: ReadonlyMap<string, { url: string; sha256: string }>, code: string, what = "the template"): string {
  return template.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (whole, inner: string) => {
    if (Object.prototype.hasOwnProperty.call(values, inner)) return values[inner]!;
    const m = /^(url|sha256):(.+)$/.exec(inner);
    const asset = m ? assets.get(m[2]!.trim()) : undefined;
    if (m && asset) return m[1] === "url" ? asset.url : asset.sha256;
    throw new PublishTargetError(
      code,
      m ? `${what} names ${whole}, and no declared asset is named ${m[2]!.trim()}` : `${what} has ${whole}, which chant does not fill`,
      `The placeholders are ${Object.keys(values).map((k) => `{{${k}}}`).join(", ")}, and {{url:<name>}} and {{sha256:<name>}} for an asset in assets: ${[...assets.keys()].join(", ")}.`,
    );
  });
}

/** An index path with `{name}`, `{version}`, `{label}`, `{letter}` and `{namePath}` filled in, refused when it names anything else or leaves the repository. */
export function fillIndexPath(pattern: string, values: { name: string; version: string; label: string }, code: string): string {
  const all: Record<string, string> = { ...values, letter: values.name.charAt(0).toLowerCase(), namePath: values.name.split(".").join("/") };
  const out = pattern.replace(/\{([A-Za-z]+)\}/g, (whole, k: string) => {
    if (Object.prototype.hasOwnProperty.call(all, k)) return all[k]!;
    throw new PublishTargetError(code, `the index path ${pattern} names ${whole}`, "A path may hold {name}, {version}, {label}, {letter} and {namePath}.");
  });
  if (isAbsolute(out) || out.startsWith("/") || out.split("/").some((s) => s === ".." || s === "." || s === "")) {
    throw new PublishTargetError(code, `the index path ${out} is not a path inside the repository`);
  }
  return out;
}

/**
 * `text` with `version = "<version>"` set in the TOML table `[<table>]`, the
 * rest of the file as it was. Null when the file has no such table.
 */
export function setTomlTableVersion(text: string, table: string, version: string): string | null {
  const lines = text.split("\n");
  const header = (l: string) => /^\s*\[/.test(l);
  const start = lines.findIndex((l) => {
    const m = /^\s*\[\s*("?)([^"\]]+)\1\s*\]\s*(#.*)?$/.exec(l);
    return m !== null && m[2] === table;
  });
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !header(lines[end]!)) end++;
  const line = `version = "${version}"`;
  const at = lines.slice(start + 1, end).findIndex((l) => /^\s*version\s*=/.test(l));
  if (at >= 0) lines[start + 1 + at] = line;
  else lines.splice(start + 1, 0, line);
  return lines.join("\n");
}

/** One thing the target writes to the index. */
type Output =
  | { kind: "file"; path: string; bytes: Uint8Array }
  /** `version` set in a TOML table of a file the index holds (Zed's `extensions.toml`). */
  | { kind: "toml-version"; path: string; table: string; version: string }
  /** A submodule pointed at a commit (Zed's `extensions/<id>`). */
  | { kind: "gitlink"; path: string; commit: string };

/** A change to commit: a file's new bytes (with the blob it replaces, for the contents API), a submodule's commit, or a file removed (#5163). */
type Change = { path: string; bytes: Uint8Array; sha: string | null } | { path: string; gitlink: string } | { path: string; remove: true };

/** How the index is read at a ref: a branch name over the API, a fetched commit over SSH. */
interface Reader {
  file(ref: string, path: string): Promise<{ bytes: Buffer; sha: string | null } | null>;
  gitlink(ref: string, path: string): Promise<string | null>;
}

const apiReader = (repo: GitHubRepo): Reader => ({
  file: (ref, path) => repo.file(path, ref),
  gitlink: (ref, path) => repo.submodule(path, ref),
});

const sshReader = (repo: SshGitRepo): Reader => ({
  file: async (ref, path) => {
    const bytes = await repo.file(ref, path);
    return bytes ? { bytes, sha: null } : null;
  },
  gitlink: (ref, path) => repo.gitlink(ref, path),
});

/** What the target is, from an `index` declaration or a `homebrew` one. */
export interface IndexSettings {
  kind: "index" | "homebrew";
  /** The error code prefix: `publish-index` or `publish-homebrew`. */
  code: string;
  key: string;
  /** The target's name in messages. */
  label: string;
  destination: string;
  /** The package's name in the index. */
  name: string;
  repo: string;
  mode: "commit" | "pull-request";
  /** Each manifest: its path pattern in the index, and its template in the member. */
  files: Array<{ path: string; template: string }>;
  zed: boolean;
  assets: string[];
  url: string | undefined;
  branch: string | undefined;
  fork: string | undefined;
  title: string;
  body: string;
  api: string | undefined;
  tokenEnv: string;
  sshKeyEnv: string | undefined;
  revealsLast: boolean;
  refusalWarns: boolean;
  /** `record`: each asset's SHA-256 is the release's record of it. `file`: the file in the checkout's, checked against the record (the `homebrew` target). */
  digests: "record" | "file";
  /** The placeholders a template may use beyond the assets'. */
  placeholders: ReadonlyArray<"version" | "label" | "tag" | "name" | "commit">;
  /** What the branch is, for a fix: "the branch brew installs from". */
  branchIs: string;
}

/** The settings of an `index` declaration, its preset filled in. Refuses a declaration that can't publish (`publish-index-invalid`). */
export function indexSettings(decl: IndexPublishDeclaration): IndexSettings {
  const preset = decl.preset ? INDEX_PRESET_DEFAULTS[decl.preset] : undefined;
  const invalid = (message: string, fix?: string): never => {
    throw new PublishTargetError("publish-index-invalid", `the index target for ${decl.name}: ${message}`, fix);
  };
  const repo = decl.repo ?? preset?.repo ?? invalid(`it names no repo${decl.preset ? `, and the ${decl.preset} preset has none` : ""}`, "Set repo to the index repository, owner/name.");
  const mode = decl.mode ?? preset?.mode ?? "pull-request";
  if (mode === "pull-request" && decl.sshKeyEnv) invalid("sshKeyEnv pushes over SSH, and a pull request is opened through the API", "Keep sshKeyEnv for mode: \"commit\", or use tokenEnv.");
  if (mode === "commit" && decl.fork) invalid("fork names where a pull request's branch goes, and mode is commit", "Drop fork, or set mode: \"pull-request\".");
  const zed = decl.preset === "zed";
  if (zed && (decl.template || decl.path)) invalid("the zed preset writes the version into extensions.toml and moves the extension's submodule, from no template", "Drop template and path.");
  const files: IndexSettings["files"] = [];
  if (decl.template) {
    const path = decl.path ?? preset?.path ?? invalid(`template needs path${decl.preset ? `, since the ${decl.preset} preset writes more than one file` : ""}`, decl.preset === "winget" ? "List the version, installer and locale manifests under files." : "Set path to where the manifest goes in the index.");
    files.push({ path, template: decl.template });
  }
  for (const [path, template] of Object.entries(decl.files ?? {})) files.push({ path, template });
  if (files.length === 0 && !zed) invalid("it names no template and no files", "Set template, or list the manifests under files.");
  const tokenEnv = decl.tokenEnv ?? preset?.tokenEnv ?? INDEX_TOKEN_ENV;
  const where = mode === "commit" ? repo : `a pull request to ${repo}`;
  return {
    kind: "index",
    code: "publish-index",
    key: publishTargetKey(decl),
    label: `index ${decl.preset ?? "repository"} ${decl.name}: ${where}`,
    destination: `github ${repo}${mode === "pull-request" ? " (pull request)" : ""}`,
    name: decl.name,
    repo,
    mode,
    files,
    zed,
    assets: decl.assets ?? [],
    url: decl.url,
    branch: decl.branch,
    fork: decl.fork,
    title: decl.title ?? preset?.title ?? "{name} {version}",
    body: decl.body ?? "Updates {name} to {version}, released as {tag}.",
    api: decl.api,
    tokenEnv,
    sshKeyEnv: decl.sshKeyEnv,
    revealsLast: true,
    refusalWarns: (decl.onRefusal ?? "warn") === "warn",
    digests: "record",
    placeholders: ["version", "label", "tag", "name", "commit"],
    branchIs: "the branch the index is read from",
  };
}

/** Fill `{name}`, `{version}`, `{label}` and `{tag}` in a title or body. */
function fillText(pattern: string, values: { name: string; version: string; label: string; tag: string }): string {
  return pattern.replace(/\{(name|version|label|tag)\}/g, (_, k: keyof typeof values) => values[k]);
}

/** An index target from a declaration. */
export function indexTarget(decl: IndexPublishDeclaration, deps: PublishDeps): PublishTarget {
  return indexTargetOf(indexSettings(decl), deps);
}

/** The target for `s`: an index declaration's, or the `homebrew` target's (./publish-homebrew.ts). */
export function indexTargetOf(s: IndexSettings, deps: PublishDeps): PublishTarget {
  const fetchImpl: PublishFetch = deps.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  const ssh = s.sshKeyEnv !== undefined;
  const tokenNames = [s.sshKeyEnv ?? s.tokenEnv];
  const code = (what: string) => `${s.code}-${what}`;
  const failed = code("failed");
  const single = s.files.length === 1 && !s.zed;
  const first = s.files[0]?.path;

  const setup = (ctx: PublishContext) => {
    const version = releaseVersion(ctx.label);
    if (!version || !ctx.label || !ctx.releaseTag) {
      throw new PublishTargetError(
        code("no-version"),
        `a ${s.kind === "homebrew" ? "formula" : "manifest"}'s version is the release's label from its first digit, and release ${ctx.release.releaseDigest} has ${ctx.label ? `the label ${ctx.label}, which has no digit` : "no label"}`,
        "Cut the release with a label such as v1.4.0.",
      );
    }
    const token = readCredential(ctx.env, tokenNames, ctx.redactor);
    if (!token) {
      throw new PublishTargetError(
        "publish-credentials-missing",
        `the ${s.kind} target reads its ${ssh ? "SSH key" : "token"} from ${tokenNames[0]}, and it is not set`,
        ssh
          ? `Set ${tokenNames[0]} to a private key that may push to ${s.repo}, such as a deploy key with write access.`
          : s.mode === "commit"
            ? `Set ${tokenNames[0]} to a token that may push to ${s.repo}.`
            : `Set ${tokenNames[0]} to a token that may fork ${s.repo}, push to the fork and open a pull request: a classic token with public_repo.`,
      );
    }
    const assets = new Map<string, { url: string; sha256: string }>();
    for (const p of expandArtifactAssets(ctx.release, s.assets)) {
      let digest: string;
      if (s.digests === "file") {
        digest = bytesDigest(new Uint8Array(readFileSync(memberFile(ctx.cwd, p))));
        checkReleaseDigest(ctx.release, "asset", ctx.cwd, p, [digest]);
      } else {
        const recorded = releaseArtifactAt(ctx.release, "asset", ctx.cwd, p);
        if (!recorded) {
          throw new PublishTargetError(
            code("asset-not-recorded"),
            `assets names ${p}, and release ${ctx.release.releaseDigest} records no such file, so it has no SHA-256 to put in the manifest`,
            "Name an entry of release.artifacts with artifact:<name>, so the cut builds and records the file.",
          );
        }
        digest = recorded.digest;
      }
      const name = basename(p);
      if (assets.has(name)) throw new PublishTargetError(code("asset-name-taken"), `two assets are named ${name}, and the template names an asset by its file name`);
      const url = fillUrl(s.url!, { tag: ctx.releaseTag, label: ctx.label, version, name });
      assets.set(name, { url, sha256: digest.slice("sha256:".length) });
    }
    const all: Record<string, string> = { version, label: ctx.label, tag: ctx.releaseTag, name: s.name, commit: ctx.release.commit };
    const values = Object.fromEntries(s.placeholders.map((k) => [k, all[k]!]));
    const outputs: Output[] = [];
    const paths = new Set<string>();
    for (const f of s.files) {
      const path = s.kind === "homebrew" ? f.path : fillIndexPath(f.path, { name: s.name, version, label: ctx.label }, code("path"));
      if (paths.has(path)) throw new PublishTargetError(code("path"), `two manifests go to ${path}`);
      paths.add(path);
      const template = readFileSync(memberFile(ctx.cwd, f.template), "utf-8");
      const text = renderManifest(template, values, assets, code("template"), s.kind === "homebrew" ? "the formula template" : `the template ${f.template}`);
      outputs.push({ kind: "file", path, bytes: new Uint8Array(Buffer.from(text, "utf-8")) });
    }
    if (s.zed) {
      outputs.push({ kind: "toml-version", path: "extensions.toml", table: s.name, version });
      outputs.push({ kind: "gitlink", path: `extensions/${s.name}`, commit: ctx.release.commit });
    }
    const items = outputs.map((o) => ({ name: o.path, digest: digestOf(o) }));
    return { version, token, assets, outputs, items, label: ctx.label, tag: ctx.releaseTag };
  };

  const digestOf = (o: Output): string | undefined => (o.kind === "file" ? bytesDigest(o.bytes) : o.kind === "toml-version" ? bytesDigest(new Uint8Array(Buffer.from(`[${o.table}] version = "${o.version}"`))) : undefined);
  const staging = (version: string) => `chant-publish/${s.name}-${version}`;
  const message = (version: string, label: string, tag: string) => fillText(s.title, { name: s.name, version, label, tag });
  const where = (branch: string, path: string) => `${s.repo}@${branch}:${path}`;
  const itemsAt = (items: Array<{ name: string; digest: string | undefined }>, branch: string, present: boolean): PublishItem[] =>
    items.map((i) => ({ name: i.name, destination: where(branch, i.name), ...(i.digest ? { digest: i.digest } : {}), ...(present ? { present: true } : {}) }));

  /** What `outputs` change at `ref`: empty when the index holds them as rendered. */
  async function changesAt(reader: Reader, ref: string, outputs: readonly Output[]): Promise<Change[]> {
    const out: Change[] = [];
    for (const o of outputs) {
      if (o.kind === "gitlink") {
        const at = await reader.gitlink(ref, o.path);
        if (at === null) {
          throw new PublishTargetError(
            code("not-listed"),
            `${s.repo} has no submodule ${o.path}, so ${s.name} is not listed there yet`,
            "Submit the extension's first version by hand, as the index asks; this target updates a listed one.",
          );
        }
        if (at !== o.commit) out.push({ path: o.path, gitlink: o.commit });
        continue;
      }
      const now = await reader.file(ref, o.path);
      if (o.kind === "file") {
        if (!now || !now.bytes.equals(Buffer.from(o.bytes))) out.push({ path: o.path, bytes: o.bytes, sha: now?.sha ?? null });
        continue;
      }
      const set = now ? setTomlTableVersion(now.bytes.toString("utf-8"), o.table, o.version) : null;
      if (set === null) {
        throw new PublishTargetError(code("not-listed"), `${o.path} in ${s.repo} has no [${o.table}] table, so ${s.name} is not listed there yet`, "Submit the first version by hand, as the index asks; this target updates a listed one.");
      }
      if (set !== now!.bytes.toString("utf-8")) out.push({ path: o.path, bytes: new Uint8Array(Buffer.from(set, "utf-8")), sha: now!.sha });
    }
    return out;
  }

  /** Commit `changes` onto `branch` of `repo` at `head` over the API: the contents API for one file, as the tap always has, else one commit through the git data API. Returns the commit. */
  async function commitOnto(repo: GitHubRepo, branch: string, head: string, changes: Change[], msg: string, force: boolean): Promise<string> {
    const only = changes[0];
    if (changes.length === 1 && only && "bytes" in only) return repo.putFile(only.path, branch, only.bytes, msg, only.sha);
    const commit = await repo.commitTree(head, changes.map(plain), msg);
    if (!(await repo.moveRef(`heads/${branch}`, commit, force))) {
      throw new PublishTargetError(failed, `${branch} of ${repo.repo} moved while ${s.name} was committed onto it`, "Run the same publish again: it commits onto the branch's new head.");
    }
    return commit;
  }

  const skipNote = (ctx: PublishContext) =>
    s.kind === "homebrew" ? `skipped: ${ctx.label} is a prerelease, and the formula is what \`brew upgrade\` installs` : `skipped: ${ctx.label} is a prerelease, and the index serves releases`;

  const target: PublishTarget = {
    kind: s.kind,
    name: s.label,
    destination: s.destination,
    credentialEnv: tokenNames,
    key: s.key,
    ...(s.revealsLast ? { revealsLast: true } : {}),
    ...(s.refusalWarns ? { refusalWarns: true } : {}),
    async setStatus(ctx: StatusContext): Promise<StatusAction[]> {
      const at = (path: string) => `${s.repo}:${path}`;
      const noun = s.kind === "homebrew" ? "formula" : "manifest";
      const named = ctx.revealed.length === 1 ? ctx.revealed[0]!.name : single && !first!.includes("{") ? first! : null;
      const shown = named ? at(named) : `${s.name}'s manifests in ${s.repo}`;
      if (ctx.status === "deprecated") return [{ what: `${shown} unchanged: ${s.kind === "homebrew" ? "a formula" : "an index"} has no deprecation; yank reverts it` }];
      if (s.mode === "pull-request") {
        return [{
          what: `${shown} unchanged`,
          refused: {
            code: "release-status-index-pull-request",
            message: `${s.repo} takes ${s.name} by pull request, merged by its maintainers, so chant does not ${ctx.status === "yanked" ? "revert" : "put back"} the ${noun}s there`,
            fix: `Open a pull request on ${s.repo} by hand${ctx.status === "yanked" ? " that takes the version out, as the index asks" : ""}.`,
          },
        }];
      }
      const ours = ctx.revealed.filter((i): i is PublishItem & { digest: string } => typeof i.digest === "string");
      if (ours.length === 0) return [{ what: `${shown} unchanged: the publish record names no ${noun} digest`, already: true }];
      const isHead = ctx.head?.releaseDigest === ctx.release.releaseDigest;
      const headName = ctx.head?.label ?? ctx.head?.releaseDigest;
      const toName = ctx.status === "active" ? (ctx.label ?? ctx.release.releaseDigest) : headName;
      // Each manifest: the digest it goes to (null: removed), or why it stays.
      type Step = { path: string; ours: string; to: string | null; what: string };
      const steps: Step[] = [];
      const actions: StatusAction[] = [];
      for (const item of ours) {
        const path = item.name;
        const held = !isHead ? ctx.head?.items.find((h) => h.name === path && h.digest)?.digest : undefined;
        if (ctx.status === "active") {
          if (held) actions.push({ what: `${at(path)} unchanged: a newer active release holds it`, already: true });
          else steps.push({ path, ours: item.digest, to: item.digest, what: `put back ${at(path)} as ${toName} published it` });
          continue;
        }
        if (held) steps.push({ path, ours: item.digest, to: held, what: `revert ${at(path)} to the ${noun} ${toName} published, if it holds this release's` });
        else if (ctx.head && !isHead) steps.push({ path, ours: item.digest, to: null, what: `remove ${at(path)}, which ${toName} did not publish, if it holds this release's` });
        else {
          actions.push({
            what: `${at(path)} stays at this release's ${noun}`,
            refused: { code: "release-status-no-previous", message: `no earlier active release published ${at(path)}, so there is no ${noun} to revert it to`, fix: `Cut and publish a release to move it to, or edit the ${noun} in ${s.repo} by hand.` },
          });
        }
      }
      if (!ctx.apply || steps.length === 0) return [...actions, ...steps.map((x) => ({ what: x.what }))];

      const token = readCredential(ctx.env, tokenNames, ctx.redactor);
      if (!token) throw new PublishTargetError("publish-credentials-missing", `the ${s.kind} target reads its ${ssh ? "SSH key" : "token"} from ${tokenNames[0]}, and it is not set`, `Set ${tokenNames[0]}.`);
      const lost = (branch: string, path: string, to: string) =>
        new PublishTargetError(`release-status-${s.kind === "homebrew" ? "homebrew" : "index"}-history`, `none of the last 100 commits of ${branch} in ${s.repo} that touch ${path} holds the ${noun} ${toName} published (${to})`, `Edit the ${noun} in ${s.repo} by hand.`);
      const version = releaseVersion(toName ?? null) ?? toName ?? "";
      const msg = fillText(s.title, { name: s.name, version, label: toName ?? "", tag: toName ?? "" });
      /** The changes `steps` make, read through `now` and `history`: a step whose path is already where it goes, or no longer this release's on a yank, is left. */
      const plan = async (branch: string, now: (path: string) => Promise<{ bytes: Buffer; sha: string | null } | null>, history: (path: string) => Promise<Buffer[]>): Promise<Change[]> => {
        const changes: Change[] = [];
        for (const x of steps) {
          const there = await now(x.path);
          const nowDigest = there ? bytesDigest(new Uint8Array(there.bytes)) : null;
          if (nowDigest === x.to || (ctx.status === "yanked" && nowDigest !== x.ours)) {
            actions.push({ what: `${at(x.path)} on ${branch} is not this release's ${noun}; not changed`, already: true });
            continue;
          }
          if (x.to === null) {
            changes.push({ path: x.path, remove: true });
          } else {
            const found = (await history(x.path)).find((b) => bytesDigest(new Uint8Array(b)) === x.to);
            if (!found) throw lost(branch, x.path, x.to);
            changes.push({ path: x.path, bytes: new Uint8Array(found), sha: there?.sha ?? null });
          }
          actions.push({ what: x.what });
        }
        return changes;
      };
      if (ssh) {
        return withSsh(ctx, token, async (repo) => {
          const { defaultBranch } = await repo.heads();
          const branch = s.branch ?? defaultBranch;
          if (!branch) throw new PublishTargetError(failed, `${repo.remote} has no default branch`, `Set branch to ${s.branchIs}.`);
          const head = await repo.fetch(branch, 100);
          const changes = await plan(
            branch,
            async (path) => {
              const b = await repo.file(head, path);
              return b ? { bytes: b, sha: null } : null;
            },
            async (path) => {
              const out: Buffer[] = [];
              for (const c of await repo.history(branch, path)) {
                const f = await repo.file(c, path);
                if (f) out.push(f);
              }
              return out;
            },
          );
          if (changes.length === 0) return actions;
          const commit = await repo.commitFiles(head, changes.map(plain), msg);
          if ((await repo.push(commit, branch, false)) === "rejected") throw new PublishTargetError(failed, `${branch} of ${repo.remote} moved while the ${noun} was committed onto it`, "Run the same command again.");
          return actions;
        });
      }
      const upstream = new GitHubRepo(githubApi(s.api, ctx.env), s.repo, token, fetchImpl, ctx, failed);
      const branch = s.branch ?? (await upstream.defaultBranch());
      const changes = await plan(
        branch,
        (path) => upstream.file(path, branch),
        async (path) => {
          const out: Buffer[] = [];
          for (const c of await upstream.commitsTouching(path, branch)) {
            const f = await upstream.file(path, c);
            if (f) out.push(f.bytes);
          }
          return out;
        },
      );
      if (changes.length === 0) return actions;
      const head = await upstream.branchHead(branch);
      if (!head) throw new PublishTargetError(failed, `${s.repo} has no branch ${branch}`, `Set branch to ${s.branchIs}.`);
      await commitOnto(upstream, branch, head, changes, msg, false);
      return actions;
    },
    async plan(ctx) {
      const branch = s.branch ?? "the default branch";
      if (prereleaseOf(ctx.label)) return [{ name: first ?? `extensions/${s.name}`, destination: where(branch, first ?? `extensions/${s.name}`), notes: skipNote(ctx) }];
      const { items } = setup(ctx);
      return itemsAt(items, branch, false);
    },
    async stage(ctx) {
      if (prereleaseOf(ctx.label)) {
        ctx.log(skipNote(ctx));
        return { target: target.name, destination: target.destination, items: [], state: { prerelease: "true" } };
      }
      const r = setup(ctx);
      ctx.log(`using the ${ssh ? "SSH key" : "token"} from ${r.token.from}`);
      for (const [name, a] of r.assets) ctx.log(`${name}: ${a.url} sha256 ${a.sha256}`);
      if (ssh) return withSsh(ctx, r.token, (repo) => stageOverSsh(ctx, repo, r));
      const upstream = new GitHubRepo(githubApi(s.api, ctx.env), s.repo, r.token, fetchImpl, ctx, failed);
      const branch = s.branch ?? (await upstream.defaultBranch());
      const head = await upstream.branchHead(branch);
      if (!head) throw new PublishTargetError(failed, `${s.repo} has no branch ${branch}`, `Set branch to ${s.branchIs}.`);
      const done = (state: Record<string, string>, present: boolean): StagedTarget => ({ target: target.name, destination: target.destination, items: itemsAt(r.items, branch, present), state: { branch, ...state } });
      const what = single ? first! : `${s.name}'s manifests`;

      const changes = await changesAt(apiReader(upstream), branch, r.outputs);
      if (changes.length === 0) {
        ctx.log(`${branch} already has ${what} for ${r.version}`);
        return done({ present: "true" }, true);
      }
      const into = s.mode === "commit" ? upstream : await forkOf(ctx, upstream, r.token);
      const at = staging(r.version);
      const stagingHead = await into.branchHead(at);
      if (stagingHead) {
        if ((await changesAt(apiReader(into), at, r.outputs)).length === 0) {
          ctx.log(`${at} already has ${what} for ${r.version}`);
          return done({ staging: at, commit: stagingHead, ...(into !== upstream ? { fork: into.repo } : {}) }, true);
        }
        await into.moveRef(`heads/${at}`, head, true);
      } else {
        await into.createBranch(at, head);
      }
      ctx.log(`committing ${what} for ${r.version} to ${at}${into !== upstream ? ` of ${into.repo}` : ""}, at ${branch}'s head ${head.slice(0, 12)}`);
      const commit = await commitOnto(into, at, head, changes, message(r.version, r.label, r.tag), true);
      return done({ staging: at, commit, ...(into !== upstream ? { fork: into.repo } : {}) }, false);
    },
    async reveal(ctx, staged) {
      if (staged.state.prerelease === "true") return { target: target.name, destination: target.destination, items: [] };
      const items = staged.items.map((i) => ({ name: i.name, destination: i.destination, ...(i.digest ? { digest: i.digest } : {}) }));
      const published = { target: target.name, destination: target.destination, items };
      if (staged.state.present === "true") return { ...published, items: items.map((i) => ({ ...i, present: true })) };
      const r = setup(ctx);
      const { branch, staging: at, commit } = staged.state;
      if (s.mode === "pull-request") return revealPull(ctx, new GitHubRepo(githubApi(s.api, ctx.env), s.repo, r.token, fetchImpl, ctx, failed), staged, r, published);
      if (!branch || !at || !commit) throw new PublishTargetError(failed, `the staged ${s.kind === "homebrew" ? "formula" : s.name} for ${s.repo} has no staging commit to reveal`);
      if (ssh) {
        await withSsh(ctx, r.token, (repo) => revealOverSsh(ctx, repo, { branch, staging: at, commit }, r));
        return published;
      }
      const upstream = new GitHubRepo(githubApi(s.api, ctx.env), s.repo, r.token, fetchImpl, ctx, failed);
      const what = single ? first! : `${s.name}'s manifests`;
      ctx.log(`fast-forwarding ${branch} to ${commit.slice(0, 12)}`);
      if (!(await upstream.moveRef(`heads/${branch}`, commit, false))) {
        // The branch moved since the stage: one commit onto it, unless it already holds the manifests.
        const changes = await changesAt(apiReader(upstream), branch, r.outputs);
        if (changes.length === 0) {
          ctx.log(`${branch} moved since the stage and already has ${what} for ${r.version}`);
        } else {
          ctx.log(`${branch} moved since the stage; committing ${what} for ${r.version} onto it`);
          const head = await upstream.branchHead(branch);
          if (!head) throw new PublishTargetError(failed, `${s.repo} has no branch ${branch}`, `Set branch to ${s.branchIs}.`);
          await commitOnto(upstream, branch, head, changes, message(r.version, r.label, r.tag), false);
        }
      }
      await upstream.deleteRef(`heads/${at}`);
      return published;
    },
  };

  /** The repository a pull request's branch goes to: `fork`, `repo` itself, or the token's user's fork, made when there is none. */
  async function forkOf(ctx: PublishContext, upstream: GitHubRepo, token: Credential): Promise<GitHubRepo> {
    if (s.fork === s.repo) return upstream;
    const api = githubApi(s.api, ctx.env);
    if (s.fork) {
      const named = new GitHubRepo(api, s.fork, token, fetchImpl, ctx, failed);
      if (!(await named.exists())) throw new PublishTargetError(failed, `the token can't see the fork ${s.fork}`, `Fork ${s.repo} to ${s.fork}, or drop fork to let the target make one.`);
      return named;
    }
    const name = await upstream.fork();
    const fork = new GitHubRepo(api, name, token, fetchImpl, ctx, failed);
    // GitHub makes a fork in the background: wait for it, up to a minute.
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    const now = deps.now ?? Date.now;
    const until = now() + 60_000;
    while (!(await fork.exists())) {
      if (now() > until) throw new PublishTargetError(failed, `GitHub did not finish forking ${s.repo} to ${name} within a minute`, "Run the same publish again: it uses the fork once it is there.");
      await sleep(2_000);
    }
    ctx.log(`the pull request's branch goes to ${name}`);
    return fork;
  }

  async function revealPull(
    ctx: PublishContext,
    upstream: GitHubRepo,
    staged: StagedTarget,
    r: ReturnType<typeof setup>,
    published: { target: string; destination: string; items: PublishItem[] },
  ) {
    const branch = staged.state.branch ?? s.branch ?? (await upstream.defaultBranch());
    const at = staging(r.version);
    const into = staged.state.fork
      ? new GitHubRepo(upstream.api, staged.state.fork, r.token, fetchImpl, ctx, failed)
      : s.fork === s.repo
        ? upstream
        : await forkOf(ctx, upstream, r.token);
    const head = `${into.repo.split("/")[0]!}:${at}`;
    const as = (url: string, present: boolean) => ({ ...published, items: published.items.map((i) => ({ ...i, destination: url, ...(present ? { present: true } : {}) })) });
    const found = await upstream.findPull(head);
    if (found?.state === "open" || found?.merged) {
      ctx.log(`${found.url} is ${found.merged ? "merged" : "open"} already; not opened again`);
      return as(found.url, true);
    }
    if (found) {
      throw new PublishTargetError(code("pr-closed"), `${s.repo} closed ${found.url} without merging it`, "Read why on the pull request. A run of the same publish opens no new one while it is closed: reopen it, or cut a new release.");
    }
    if ((await changesAt(apiReader(upstream), branch, r.outputs)).length === 0) {
      ctx.log(`${branch} of ${s.repo} already has ${s.name} ${r.version}; no pull request needed`);
      return as(`${s.repo}@${branch}`, true);
    }
    // The branch may be gone, or this run resumes from another: make sure it holds the manifests, then open the pull request.
    const onto = await upstream.branchHead(branch);
    if (!onto) throw new PublishTargetError(failed, `${s.repo} has no branch ${branch}`, `Set branch to ${s.branchIs}.`);
    const there = await into.branchHead(at);
    if (!there || (await changesAt(apiReader(into), at, r.outputs)).length > 0) {
      const changes = await changesAt(apiReader(upstream), branch, r.outputs);
      if (there) await into.moveRef(`heads/${at}`, onto, true);
      else await into.createBranch(at, onto);
      await commitOnto(into, at, onto, changes, message(r.version, r.label, r.tag), true);
    }
    const pull = await upstream.openPull(message(r.version, r.label, r.tag), fillText(s.body, { name: s.name, version: r.version, label: r.label, tag: r.tag }), head, branch);
    ctx.log(`opened ${pull.url}`);
    return as(pull.url, false);
  }

  async function withSsh<T>(ctx: PublishContextBase, key: Credential, step: (repo: SshGitRepo) => Promise<T>): Promise<T> {
    const repo = await SshGitRepo.open({ api: githubApi(s.api, ctx.env), repo: s.repo, key, ctx, fetch: fetchImpl, code: failed, git: deps.git, ssh: deps.ssh });
    try {
      return await step(repo);
    } finally {
      repo.close();
    }
  }

  async function stageOverSsh(ctx: PublishContext, repo: SshGitRepo, r: ReturnType<typeof setup>): Promise<StagedTarget> {
    const { defaultBranch, heads } = await repo.heads();
    const branch = s.branch ?? defaultBranch;
    const head = branch ? heads.get(branch) : undefined;
    if (!branch || !head) throw new PublishTargetError(failed, `${repo.remote} has no branch ${branch ?? "HEAD points at"}`, `Set branch to ${s.branchIs}.`);
    const done = (state: Record<string, string>, present: boolean): StagedTarget => ({ target: target.name, destination: target.destination, items: itemsAt(r.items, branch, present), state: { branch, ...state } });
    const what = single ? first! : `${s.name}'s manifests`;
    ctx.log(`reading ${branch} of ${repo.remote} over SSH`);
    await repo.fetch(branch);
    const changes = await changesAt(sshReader(repo), head, r.outputs);
    if (changes.length === 0) {
      ctx.log(`${branch} already has ${what} for ${r.version}`);
      return done({ present: "true" }, true);
    }
    const at = staging(r.version);
    const stagingHead = heads.get(at);
    if (stagingHead) {
      await repo.fetch(at);
      if ((await changesAt(sshReader(repo), stagingHead, r.outputs)).length === 0) {
        ctx.log(`${at} already has ${what} for ${r.version}`);
        return done({ staging: at, commit: stagingHead }, true);
      }
    }
    ctx.log(`committing ${what} for ${r.version} to ${at}, at ${branch}'s head ${head.slice(0, 12)}, and pushing it over SSH`);
    const commit = await repo.commitFiles(head, changes.map(plain), message(r.version, r.label, r.tag));
    await repo.push(commit, at, true);
    return done({ staging: at, commit }, false);
  }

  async function revealOverSsh(ctx: PublishContext, repo: SshGitRepo, state: { branch: string; staging: string; commit: string }, r: ReturnType<typeof setup>): Promise<void> {
    const { branch, staging: at, commit } = state;
    const what = single ? first! : `${s.name}'s manifests`;
    const { heads } = await repo.heads();
    // The staged commit is on the staging branch: fetch it, since this run may be a resume on a fresh clone.
    // Depth 2: the staged commit and the head it was made on, so git sees the push as a fast-forward.
    const stagingHead = heads.get(at) === commit ? await repo.fetch(at, 2) : null;
    let moved = true;
    if (stagingHead === commit) {
      ctx.log(`fast-forwarding ${branch} to ${commit.slice(0, 12)} over SSH`);
      moved = (await repo.push(commit, branch, false)) === "rejected";
    } else {
      ctx.log(`${at} is not at the staged commit ${commit.slice(0, 12)} any more`);
    }
    if (moved) {
      // The branch moved since the stage, or the staged commit is gone: one commit onto it, unless it already holds the manifests.
      const head = await repo.fetch(branch);
      const changes = await changesAt(sshReader(repo), head, r.outputs);
      if (changes.length === 0) {
        ctx.log(`${branch} already has ${what} for ${r.version}`);
      } else {
        ctx.log(`committing ${what} for ${r.version} onto ${branch}'s head ${head.slice(0, 12)}`);
        const onto = await repo.commitFiles(head, changes.map(plain), message(r.version, r.label, r.tag));
        if ((await repo.push(onto, branch, false)) === "rejected") {
          throw new PublishTargetError(failed, `${branch} of ${repo.remote} moved again while ${what} was committed onto it`, `Run the same publish again: it commits ${s.kind === "homebrew" ? "the formula" : "the manifests"} onto the branch's new head.`);
        }
      }
    }
    await repo.deleteBranch(at);
  }

  return target;
}

const plain = (c: Change): { path: string; bytes: Uint8Array } | { path: string; gitlink: string } | { path: string; remove: true } => ("bytes" in c ? { path: c.path, bytes: c.bytes } : c);
