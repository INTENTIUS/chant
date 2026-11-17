/**
 * The Helm target (#5233): chart archives pushed to an OCI registry, and
 * listed in a classic chart repository's `index.yaml`.
 *
 * Each chart is a `.tgz` as `helm package` writes it, or as a `helm` entry of
 * `release.artifacts` packs it (./release-artifacts.ts). Its name, version
 * and the rest of its `Chart.yaml` are read from the archive, and a chart
 * whose version is not the release's label from its first digit is refused
 * (`publish-helm-version-mismatch`).
 *
 * `oci`: the chart goes to `<repository>/<chart name>` as `helm push` puts
 * it: an image manifest whose config is the chart's metadata as JSON
 * (`application/vnd.cncf.helm.config.v1+json`) and whose one layer is the
 * archive (`application/vnd.cncf.helm.chart.content.v1.tar+gzip`). The
 * registry is spoken to as the `oci` target speaks to it (./publish-oci.ts),
 * with the same credentials. The stage pushes by digest; the reveal tags
 * the digest with the chart's version (`+` written `_`, as helm does), which
 * is what `helm install oci://<repository>/<name> --version <version>` reads.
 *
 * `index`: a chart repository served from a branch of a GitHub repository,
 * such as `gh-pages`. The index's entry for each chart is its `Chart.yaml`
 * with `urls`, `created` and `digest`, as `helm repo index` writes it. With
 * `url`, each chart is downloaded from there, such as the forge release a
 * `forge` target attaches it to; without it, the archive is committed
 * beside the index and named by its file name. The stage commits to
 * `chant-publish/helm-<version>` at the branch's head, and the reveal
 * fast-forwards the branch, or commits onto it when it moved. The index is
 * read and added to, never rewritten: a version it lists with the same
 * digest is left, and one it lists with another is refused
 * (`publish-helm-version-taken`), since a chart version is never replaced.
 * With `index`, the target reveals after every other target, since the
 * index points at files they make downloadable.
 */

import { readFileSync } from "node:fs";
import { basename, posix } from "node:path";
import { gunzipSync } from "node:zlib";
import { readCredential, type Credential } from "./publish-credentials";
import type { HelmPublishDeclaration } from "./publish-declaration";
import { GitHubRepo, githubApi } from "./publish-github";
import { fillUrl, releaseVersion } from "./publish-index";
import { Registry, ociCredential, parseRepository } from "./publish-oci";
import { bytesDigest, checkReleaseDigest, expandArtifactAssets, memberFile, publishTargetKey } from "./publish-targets";
import { trainName, waitUntilServed } from "./publish-train-names";
import { PublishTargetError, type PublishContext, type PublishContextBase, type PublishDeps, type PublishFetch, type PublishItem, type PublishTarget } from "./release-publish";
import { emitYAML, parseYAML } from "../yaml";

/** The first chant that publishes a `helm` target (#5233). */
export const PUBLISH_HELM_FLOOR = "0.124.102";

/** The media type of a chart's config blob: its metadata as JSON. */
export const HELM_CONFIG_MEDIA_TYPE = "application/vnd.cncf.helm.config.v1+json";
/** The media type of a chart's archive layer. */
export const HELM_CHART_MEDIA_TYPE = "application/vnd.cncf.helm.chart.content.v1.tar+gzip";
const IMAGE_MANIFEST = "application/vnd.oci.image.manifest.v1+json";

/** The variable the index's token is read from when the declaration names none. */
export const HELM_INDEX_TOKEN_ENV = "GITHUB_TOKEN";

/** What a chart archive holds, as the target reads it. */
export interface ChartArchive {
  /** The path the target names, relative to the member. */
  path: string;
  /** The archive's file name. */
  file: string;
  bytes: Uint8Array;
  /** `sha256:<hex>` of the archive. */
  digest: string;
  name: string;
  version: string;
  /** The chart's `Chart.yaml`, as read. */
  metadata: Record<string, unknown>;
}

/**
 * The `Chart.yaml` of a chart archive: the one file `<dir>/Chart.yaml` at the
 * top of its gzipped tar. Reads ustar names, with a GNU long name or a PAX
 * `path` in place of a short one. Null when the archive has none.
 */
export function chartYamlOf(gz: Uint8Array): string | null {
  let tar: Buffer;
  try {
    tar = gunzipSync(gz);
  } catch {
    return null;
  }
  let at = 0;
  let longName: string | null = null;
  const text = (b: Buffer) => b.toString("utf-8").replace(/\0.*$/s, "");
  while (at + 512 <= tar.length) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(text(h.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(h[156]!);
    const prefix = text(h.subarray(345, 500));
    const short = text(h.subarray(0, 100));
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = text(body);
      continue;
    }
    if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf-8"));
      if (m) longName = m[1]!;
      continue;
    }
    if (type === "g") continue;
    const name = (longName ?? (prefix ? `${prefix}/${short}` : short)).replace(/^\.\//, "");
    longName = null;
    if ((type === "0" || type === "\0") && /^[^/]+\/Chart\.yaml$/.test(name)) return body.toString("utf-8");
  }
  return null;
}

/** Read a chart archive's metadata, refused (`publish-helm-not-a-chart`) when it holds no readable `Chart.yaml` with a name and a version. */
export function readChartArchive(path: string, bytes: Uint8Array): ChartArchive {
  const yaml = chartYamlOf(bytes);
  const refuse = (why: string): never => {
    throw new PublishTargetError("publish-helm-not-a-chart", `${path} is not a Helm chart archive: ${why}`, "Name the .tgz helm package writes, or a helm entry of release.artifacts with artifact:<name>.");
  };
  if (yaml === null) refuse("it is not a gzipped tar with a <chart>/Chart.yaml");
  let metadata: Record<string, unknown> = {};
  try {
    metadata = parseYAML(yaml!);
  } catch (err) {
    refuse(`its Chart.yaml is not YAML chant can read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const name = metadata.name;
  const version = metadata.version;
  if (typeof name !== "string" || name === "") refuse("its Chart.yaml has no name");
  if (typeof version !== "string" || version === "") refuse("its Chart.yaml has no version");
  return { path, file: basename(path), bytes, digest: bytesDigest(bytes), name: name as string, version: version as string, metadata };
}

/** The OCI tag of a chart version: helm writes `+` as `_`, which a tag can't hold. */
export function helmOciTag(version: string): string {
  return version.replace(/\+/g, "_");
}

/** The config blob and the manifest `helm push` would make for a chart, with no time in them, so the same chart is the same digest. */
export function helmOciManifest(chart: ChartArchive): { config: Uint8Array; manifest: Uint8Array; digest: string } {
  const config = new Uint8Array(Buffer.from(JSON.stringify(chart.metadata)));
  const annotations: Record<string, string> = { "org.opencontainers.image.title": chart.name, "org.opencontainers.image.version": chart.version };
  if (typeof chart.metadata.description === "string" && chart.metadata.description !== "") annotations["org.opencontainers.image.description"] = chart.metadata.description;
  const manifest = new Uint8Array(
    Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: IMAGE_MANIFEST,
        config: { mediaType: HELM_CONFIG_MEDIA_TYPE, digest: bytesDigest(config), size: config.byteLength },
        layers: [{ mediaType: HELM_CHART_MEDIA_TYPE, digest: chart.digest, size: chart.bytes.byteLength }],
        annotations,
      }),
    ),
  );
  return { config, manifest, digest: bytesDigest(manifest) };
}

/** A chart repository index, as helm writes it. */
interface HelmIndex {
  apiVersion: string;
  entries: Record<string, Array<Record<string, unknown>>>;
  generated?: string;
  [k: string]: unknown;
}

/**
 * The index with each chart's entry added, or null when it lists every chart
 * already with the same digest. A version it lists with another digest is
 * refused.
 */
export function addToHelmIndex(existing: string | null, charts: ReadonlyArray<{ chart: ChartArchive; url: string }>, created: string, where: string): string | null {
  let index: HelmIndex;
  if (existing === null || existing.trim() === "") index = { apiVersion: "v1", entries: {} };
  else {
    try {
      index = parseYAML(existing) as HelmIndex;
    } catch (err) {
      throw new PublishTargetError("publish-helm-index-unreadable", `${where} is not YAML chant can read: ${err instanceof Error ? err.message : String(err)}`, "Fix the index by hand, or point index.path at the chart repository's index.yaml.");
    }
    if (typeof index !== "object" || index === null || (index.entries !== undefined && (typeof index.entries !== "object" || index.entries === null))) {
      throw new PublishTargetError("publish-helm-index-unreadable", `${where} is not a chart repository index: it has no entries map`);
    }
    index.entries ??= {};
    index.apiVersion ??= "v1";
  }
  let changed = false;
  for (const { chart, url } of charts) {
    const list = Array.isArray(index.entries[chart.name]) ? index.entries[chart.name]! : [];
    const hex = chart.digest.slice("sha256:".length);
    const listed = list.find((e) => e.version === chart.version);
    if (listed) {
      if (listed.digest === hex) continue;
      throw new PublishTargetError(
        "publish-helm-version-taken",
        `${where} lists ${chart.name} ${chart.version} with the digest ${String(listed.digest)}, and this chart is ${hex}`,
        "A chart version is never replaced: cut a new release, so the chart carries a new version.",
      );
    }
    index.entries[chart.name] = [{ ...chart.metadata, urls: [url], created, digest: hex }, ...list];
    changed = true;
  }
  if (!changed) return null;
  index.generated = created;
  const { apiVersion, entries, generated, ...rest } = index;
  return `${emitYAML({ apiVersion, entries, generated, ...rest }, 0).replace(/\n*$/, "")}\n`;
}

export function helmTarget(decl: HelmPublishDeclaration, deps: PublishDeps): PublishTarget {
  const fetchImpl: PublishFetch = deps.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  const failed = "publish-helm-failed";
  const ix = decl.index;
  const branch = ix?.branch ?? "gh-pages";
  const indexPath = ix?.path ?? "index.yaml";
  const indexDir = posix.dirname(indexPath) === "." ? "" : posix.dirname(indexPath);
  const tokenEnv = ix?.tokenEnv ?? HELM_INDEX_TOKEN_ENV;
  const credentialEnv = [...(decl.oci ? [decl.oci.passwordEnv ?? "OCI_PASSWORD"] : []), ...(ix ? [tokenEnv] : [])];
  const where = [decl.oci ? decl.oci.repository : null, ix ? `${ix.repo}@${branch}:${indexPath}` : null].filter(Boolean).join(" and ");
  const now = () => new Date(deps.now ? deps.now() : Date.now()).toISOString();

  /** Each chart named, read and checked against the release's record and its label. */
  const charts = (ctx: PublishContext): ChartArchive[] => {
    const version = releaseVersion(ctx.label);
    const out: ChartArchive[] = [];
    for (const p of expandArtifactAssets(ctx.release, decl.charts)) {
      const bytes = new Uint8Array(readFileSync(memberFile(ctx.cwd, p)));
      checkReleaseDigest(ctx.release, "asset", ctx.cwd, p, [bytesDigest(bytes)]);
      const chart = readChartArchive(p, bytes);
      if (version !== null && chart.version !== version) {
        throw new PublishTargetError(
          "publish-helm-version-mismatch",
          `${p} is ${chart.name} ${chart.version}, and the release is labelled ${ctx.label}, so the chart's version would not be the release's`,
          "Pack the chart at the cut with a helm entry of release.artifacts, which sets its version from the label, or set version in Chart.yaml to the label from its first digit.",
        );
      }
      if (out.some((c) => c.name === chart.name)) throw new PublishTargetError("publish-helm-chart-taken", `two of the charts are named ${chart.name}`, "Name each chart once.");
      out.push(chart);
    }
    return out;
  };

  const ociRef = (chart: ChartArchive) => `${decl.oci!.repository.replace(/\/+$/, "")}/${chart.name}`;
  const connect = (ctx: PublishContextBase, chart: ChartArchive) => {
    const repo = parseRepository(ociRef(chart));
    const cred = ociCredential({ ...(decl.oci!.usernameEnv ? { usernameEnv: decl.oci!.usernameEnv } : {}), ...(decl.oci!.passwordEnv ? { passwordEnv: decl.oci!.passwordEnv } : {}) }, repo, ctx);
    return { cred, registry: new Registry(repo, fetchImpl, cred, ctx, deps.sleep) };
  };
  const ociItem = (chart: ChartArchive, digest: string): PublishItem => ({ name: `${chart.file} (tag ${helmOciTag(chart.version)})`, destination: `${ociRef(chart)}@${digest}`, digest });

  const token = (ctx: PublishContextBase): Credential => {
    const t = readCredential(ctx.env, [tokenEnv], ctx.redactor);
    if (!t) throw new PublishTargetError("publish-credentials-missing", `the helm target reads the token for ${ix!.repo} from ${tokenEnv}, and it is not set`, `Set ${tokenEnv} to a token that may push to ${branch} of ${ix!.repo}.`);
    return t;
  };
  const github = (ctx: PublishContextBase) => new GitHubRepo(githubApi(ix!.api, ctx.env), ix!.repo, token(ctx), fetchImpl, ctx, failed);
  /** Each chart and the URL the index gives it. */
  const listed = (ctx: PublishContext, cs: readonly ChartArchive[]) => {
    const version = releaseVersion(ctx.label) ?? "";
    return cs.map((chart) => ({
      chart,
      url: ix!.url ? fillUrl(ix!.url, { tag: ctx.releaseTag ?? "", label: ctx.label ?? "", version, name: chart.file }) : chart.file,
      path: indexDir ? `${indexDir}/${chart.file}` : chart.file,
    }));
  };
  /** What the branch at `ref` needs: the index with the charts added, and each archive committed beside it when there is no `url`. */
  const changesAt = async (repo: GitHubRepo, ref: string, ctx: PublishContext, cs: readonly ChartArchive[]): Promise<Array<{ path: string; bytes: Uint8Array }>> => {
    const entries = listed(ctx, cs);
    const now0 = await repo.file(indexPath, ref);
    const created = ctx.cut?.timestamp ?? now();
    const text = addToHelmIndex(now0 ? now0.bytes.toString("utf-8") : null, entries, created, `${ix!.repo}@${ref}:${indexPath}`);
    const out: Array<{ path: string; bytes: Uint8Array }> = [];
    if (!ix!.url) {
      for (const e of entries) {
        const there = await repo.file(e.path, ref);
        if (!there || bytesDigest(new Uint8Array(there.bytes)) !== e.chart.digest) out.push({ path: e.path, bytes: e.chart.bytes });
      }
    }
    if (text !== null) out.push({ path: indexPath, bytes: new Uint8Array(Buffer.from(text, "utf-8")) });
    return out;
  };
  const indexItems = (ctx: PublishContext, cs: readonly ChartArchive[], present: boolean): PublishItem[] =>
    listed(ctx, cs).flatMap((e) => [
      ...(ix!.url ? [] : [{ name: e.chart.file, destination: `${ix!.repo}@${branch}:${e.path}`, digest: e.chart.digest, ...(present ? { present: true } : {}) }]),
      { name: `${e.chart.name} ${e.chart.version} in ${indexPath}`, destination: `${ix!.repo}@${branch}:${indexPath}`, ...(present ? { present: true } : {}) },
    ]);
  const message = (ctx: PublishContext, cs: readonly ChartArchive[]) => `${cs.map((c) => `${c.name} ${c.version}`).join(", ")}${ctx.releaseTag ? `, released as ${ctx.releaseTag}` : ""}`;
  const staging = (ctx: PublishContext) => `chant-publish/helm-${releaseVersion(ctx.label) ?? ctx.release.releaseDigest.slice(0, 12)}`;

  const target: PublishTarget = {
    kind: "helm",
    name: `helm ${decl.charts.join(", ")}`,
    destination: where,
    credentialEnv,
    key: publishTargetKey(decl),
    ...(ix ? { revealsLast: true } : {}),
    /** #5165: each chart, under the OCI repository it goes to and the index that lists it. */
    async names(ctx) {
      const provides = new Set<string>();
      let cs: ChartArchive[] = [];
      try {
        cs = charts(ctx);
      } catch {
        cs = [];
      }
      for (const c of cs) {
        if (decl.oci) provides.add(trainName("oci", ociRef(c)));
        if (ix) provides.add(trainName("index", `${ix.repo}/${c.name}`));
      }
      return { provides: [...provides], needs: [] };
    },
    /** #5165: whether each chart's version tag is in the registry and the index lists each version; null when the charts can't be read here. */
    async published(ctx) {
      let cs: ChartArchive[];
      try {
        cs = charts(ctx);
      } catch {
        return null;
      }
      if (decl.oci) {
        for (const c of cs) if ((await connect(ctx, c).registry.getManifest(helmOciTag(c.version))) === null) return false;
      }
      if (ix) {
        if (!readCredential(ctx.env, [tokenEnv], ctx.redactor)) return null;
        const there = await github(ctx).file(indexPath, branch);
        if (!there) return false;
        let index: HelmIndex;
        try {
          index = parseYAML(there.bytes.toString("utf-8")) as HelmIndex;
        } catch {
          return null;
        }
        for (const c of cs) if (!(index.entries?.[c.name] ?? []).some((e) => e.version === c.version)) return false;
      }
      return true;
    },
    /** #5165: wait until each version tag names the chart's manifest, and the branch's index lists each chart. */
    async visible(ctx, published) {
      const oci = published.items.filter((i): i is PublishItem & { digest: string } => typeof i.digest === "string" && / \(tag [^)]+\)$/.test(i.name));
      await waitUntilServed(ctx, deps, {
        what: where,
        code: "publish-helm-not-served",
        check: async () => {
          const missing: string[] = [];
          for (const i of oci) {
            const at = i.destination.lastIndexOf("@");
            const ref = i.destination.slice(0, at);
            const tag = /\(tag ([^)]+)\)$/.exec(i.name)![1]!;
            const repo = parseRepository(ref);
            const cred = ociCredential({ ...(decl.oci?.usernameEnv ? { usernameEnv: decl.oci.usernameEnv } : {}), ...(decl.oci?.passwordEnv ? { passwordEnv: decl.oci.passwordEnv } : {}) }, repo, ctx);
            const got = await new Registry(repo, fetchImpl, cred, ctx, deps.sleep).getManifest(tag);
            if (got?.digest !== i.digest) missing.push(`${ref}:${tag}`);
          }
          if (ix && readCredential(ctx.env, [tokenEnv], ctx.redactor)) {
            const names = published.items.map((i) => / in [^ ]+$/.exec(i.name) ? i.name.replace(/ in [^ ]+$/, "").split(" ") : null).filter((n): n is string[] => n !== null && n.length === 2);
            if (names.length > 0) {
              const there = await github(ctx).file(indexPath, branch);
              const index = there ? (parseYAML(there.bytes.toString("utf-8")) as HelmIndex) : null;
              for (const [name, version] of names) if (!(index?.entries?.[name!] ?? []).some((e) => e.version === version)) missing.push(`${name} ${version} in ${ix.repo}@${branch}:${indexPath}`);
            }
          }
          return missing;
        },
      });
    },
    async plan(ctx) {
      const cs = charts(ctx);
      if (decl.oci) for (const c of cs) connect(ctx, c);
      if (ix) token(ctx);
      return [...(decl.oci ? cs.map((c) => ociItem(c, helmOciManifest(c).digest)) : []), ...(ix ? indexItems(ctx, cs, false) : [])];
    },
    async stage(ctx) {
      const cs = charts(ctx);
      const items: PublishItem[] = [];
      const state: Record<string, string> = {};
      if (decl.oci) {
        for (const c of cs) {
          const { cred, registry } = connect(ctx, c);
          const m = helmOciManifest(c);
          if (await registry.hasManifest(m.digest, IMAGE_MANIFEST)) {
            ctx.log(`${ociRef(c)} already holds ${m.digest}; the chart is not pushed again`);
            items.push({ ...ociItem(c, m.digest), present: true });
            continue;
          }
          ctx.log(`pushing ${c.path} to ${ociRef(c)} by digest ${m.digest}, ${cred ? `with credentials from ${cred.password.from}` : "anonymously"}; no tag moves yet`);
          await registry.pushBlob(bytesDigest(m.config), () => m.config);
          await registry.pushBlob(c.digest, () => c.bytes);
          await registry.putManifest(m.digest, IMAGE_MANIFEST, m.manifest);
          items.push(ociItem(c, m.digest));
        }
      }
      if (ix) {
        const repo = github(ctx);
        const head = await repo.branchHead(branch);
        if (!head) throw new PublishTargetError(failed, `${ix.repo} has no branch ${branch}`, `Create ${branch} in ${ix.repo}, such as an empty branch GitHub Pages serves, or set index.branch.`);
        const changes = await changesAt(repo, branch, ctx, cs);
        if (changes.length === 0) {
          ctx.log(`${branch} of ${ix.repo} already lists ${cs.map((c) => `${c.name} ${c.version}`).join(", ")}`);
          items.push(...indexItems(ctx, cs, true));
          state.present = "true";
        } else {
          const at = staging(ctx);
          ctx.log(`committing ${changes.map((c) => c.path).join(", ")} to ${at} of ${ix.repo}, at ${branch}'s head ${head.slice(0, 12)}`);
          const commit = await repo.commitTree(head, changes, message(ctx, cs));
          if ((await repo.branchHead(at)) === null) await repo.createBranch(at, commit);
          else await repo.moveRef(`heads/${at}`, commit, true);
          items.push(...indexItems(ctx, cs, false));
          Object.assign(state, { staging: at, commit });
        }
      }
      return { target: target.name, destination: target.destination, items, state };
    },
    async reveal(ctx, staged) {
      const cs = charts(ctx);
      const items: PublishItem[] = [];
      if (decl.oci) {
        for (const c of cs) {
          const { registry } = connect(ctx, c);
          const m = helmOciManifest(c);
          const tag = helmOciTag(c.version);
          const now0 = await registry.getManifest(tag);
          if (now0?.digest === m.digest) ctx.log(`${ociRef(c)}:${tag} already names ${m.digest}`);
          else {
            await registry.putManifest(tag, IMAGE_MANIFEST, m.manifest);
            ctx.log(`tagged ${ociRef(c)}@${m.digest} ${tag}`);
          }
          items.push(ociItem(c, m.digest));
        }
      }
      if (ix) {
        if (staged.state.present === "true") {
          items.push(...indexItems(ctx, cs, true));
        } else {
          const repo = github(ctx);
          const { staging: at, commit } = staged.state;
          if (!at || !commit) throw new PublishTargetError(failed, `the staged index for ${ix.repo} has no staging commit to reveal`, "Run the same publish again: it stages the index again.");
          ctx.log(`fast-forwarding ${branch} of ${ix.repo} to ${commit.slice(0, 12)}`);
          if (!(await repo.moveRef(`heads/${branch}`, commit, false))) {
            const changes = await changesAt(repo, branch, ctx, cs);
            if (changes.length === 0) ctx.log(`${branch} moved since the stage and already lists the charts`);
            else {
              ctx.log(`${branch} moved since the stage; committing the index onto it`);
              const head = await repo.branchHead(branch);
              if (!head) throw new PublishTargetError(failed, `${ix.repo} has no branch ${branch}`, `Create ${branch} in ${ix.repo}, or set index.branch.`);
              const onto = await repo.commitTree(head, changes, message(ctx, cs));
              if (!(await repo.moveRef(`heads/${branch}`, onto, false))) throw new PublishTargetError(failed, `${branch} of ${ix.repo} moved again while the index was committed onto it`, "Run the same publish again: it commits the index onto the branch's new head.");
            }
          }
          await repo.deleteRef(`heads/${at}`);
          items.push(...indexItems(ctx, cs, false));
        }
      }
      return { target: target.name, destination: target.destination, items };
    },
  };
  return target;
}
