/**
 * `chant release init` for a goreleaser config that builds container images
 * (#5269): its `dockers` (with `docker_manifests`) or `dockers_v2` read as
 * one `release.images` Dockerfile entry and an `oci` target with the same
 * repository, tags, per-platform tags, build arguments and labels, so a
 * project that adopts the plan keeps publishing its image. What does not
 * translate is named, never dropped without a word.
 *
 * goreleaser's templates map to chant's placeholders: `{{ .Version }}` is
 * `{version}`. Any other template is not carried.
 */
import { parseYAML } from "../yaml";
import { imageArchiveBesideGoreleaser } from "./release-images";

/** The image a goreleaser config builds, as `release init` declares it. */
export interface GoreleaserImage {
  /** The `release.images` entry's name: the repository's last segment. */
  name: string;
  repository: string;
  dockerfile: string;
  platforms: string[];
  args: Record<string, string>;
  labels: Record<string, string>;
  /** The oci target's tags. */
  tags: string[];
  /** The oci target's `platformTags`, such as `{version}-{arch}`. */
  platformTags: string[];
  archive: string;
  /** The goreleaser keys the plan replaces, to remove from the config. */
  keys: string[];
  /** What was not carried, each in words. */
  unread: string[];
}

const VERSION = /\{\{\s*\.Version\s*\}\}/g;

/** A goreleaser template as a chant value, or null when it holds a template chant has no placeholder for. */
function template(t: string): string | null {
  const v = t.replace(VERSION, "{version}");
  return /\{\{/.test(v) ? null : v;
}

/** `repo:tag` split at the tag's colon (a registry port's colon comes before the last slash). */
function splitRef(ref: string): { repository: string; tag: string } | null {
  const at = ref.lastIndexOf(":");
  if (at <= ref.lastIndexOf("/")) return null;
  return { repository: ref.slice(0, at), tag: ref.slice(at + 1) };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

/** `--build-arg=K=V`, `--label=K=V` and `--platform=...` flags into args and labels; the rest is not carried. */
function readFlags(flags: string[], into: { args: Record<string, string>; labels: Record<string, string>; unread: string[] }): void {
  for (const f of flags) {
    const m = /^--(build-arg|label)[= ]([^=\s]+)=(.*)$/.exec(f.trim());
    if (m) {
      const value = template(m[3]!);
      if (value === null) into.unread.push(`the ${m[1]} ${m[2]}=${m[3]}, whose template chant has no placeholder for`);
      else (m[1] === "label" ? into.labels : into.args)[m[2]!] = value;
    } else if (!/^--platform[= ]/.test(f.trim())) into.unread.push(`the build flag ${f}`);
  }
}

/** The image a goreleaser config builds, or null when it builds none with `dockers` or `dockers_v2`. */
export function goreleaserImage(text: string): GoreleaserImage | null {
  let doc: Record<string, unknown>;
  try {
    doc = parseYAML(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const unread: string[] = [];
  const args: Record<string, string> = {};
  const labels: Record<string, string> = {};
  const flags = { args, labels, unread };
  const platforms: string[] = [];
  const tags: string[] = [];
  const platformTags = new Set<string>();
  const repositories = new Set<string>();
  const dockerfiles = new Set<string>();
  const keys: string[] = [];
  const addTag = (raw: string) => {
    const t = template(raw);
    if (t === null) unread.push(`the tag ${raw}, whose template chant has no placeholder for`);
    else if (!tags.includes(t)) tags.push(t);
  };

  const v2 = Array.isArray(doc.dockers_v2) ? (doc.dockers_v2 as Array<Record<string, unknown>>) : [];
  const v1 = Array.isArray(doc.dockers) ? (doc.dockers as Array<Record<string, unknown>>) : [];
  if (v2.length > 0) {
    keys.push("dockers_v2");
    for (const d of v2) {
      for (const r of strings(d.images)) repositories.add(r);
      dockerfiles.add(typeof d.dockerfile === "string" ? d.dockerfile : "Dockerfile");
      for (const p of strings(d.platforms)) if (!platforms.includes(p)) platforms.push(p);
      for (const t of strings(d.tags)) addTag(t);
      for (const [k, v] of Object.entries((d.build_args as Record<string, unknown>) ?? {})) {
        const value = typeof v === "string" ? template(v) : null;
        if (value === null) unread.push(`the build argument ${k}, whose value chant can't carry`);
        else args[k] = value;
      }
      for (const [k, v] of Object.entries((d.labels as Record<string, unknown>) ?? {})) {
        const value = typeof v === "string" ? template(v) : null;
        if (value === null) unread.push(`the label ${k}, whose value chant can't carry`);
        else labels[k] = value;
      }
      readFlags(strings(d.flags), flags);
    }
  }
  if (v1.length > 0) {
    keys.push("dockers");
    // The images each entry pushes: per platform, or the whole image when there are no manifests.
    const manifests = Array.isArray(doc.docker_manifests) ? (doc.docker_manifests as Array<Record<string, unknown>>) : [];
    if (manifests.length > 0) keys.push("docker_manifests");
    for (const d of v1) {
      const goos = typeof d.goos === "string" ? d.goos : "linux";
      const goarch = typeof d.goarch === "string" ? d.goarch : "amd64";
      const variant = goarch === "arm" && d.goarm !== undefined ? `v${String(d.goarm)}` : "";
      const platform = `${goos}/${goarch}${variant ? `/${variant}` : ""}`;
      if (!platforms.includes(platform)) platforms.push(platform);
      dockerfiles.add(typeof d.dockerfile === "string" ? d.dockerfile : "Dockerfile");
      readFlags(strings(d.build_flag_templates), flags);
      for (const ref of strings(d.image_templates)) {
        const r = splitRef(ref);
        if (!r) {
          unread.push(`the image ${ref}, which names no tag`);
          continue;
        }
        repositories.add(r.repository);
        const t = template(r.tag);
        const arch = `${goarch}${variant}`;
        if (manifests.length === 0) addTag(r.tag);
        else if (t !== null && t.includes(arch)) platformTags.add(t.split(arch).join("{arch}"));
        else unread.push(`the per-platform tag ${r.tag}, which does not name its platform's architecture`);
      }
    }
    for (const m of manifests) {
      const name = typeof m.name_template === "string" ? splitRef(m.name_template) : null;
      if (!name) continue;
      repositories.add(name.repository);
      addTag(name.tag);
    }
  }
  if (keys.length === 0) return null;
  if (Object.keys(doc).includes("kos")) unread.push("the kos images, which chant does not build");
  const [repository, ...others] = [...repositories];
  if (!repository) return null;
  if (others.length > 0) unread.push(`the images pushed to ${others.join(", ")}, as one oci target pushes to one repository`);
  const [dockerfile, ...moreFiles] = [...dockerfiles];
  if (moreFiles.length > 0) unread.push(`the images built from ${moreFiles.join(", ")}, as one entry builds one Dockerfile`);
  const name = (repository.split("/").pop() ?? "image").toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "image";
  // A platform tag that names no version would move with every release; chant tags each release's own.
  const ownTags = [...platformTags].filter((t) => t.includes("{version}") || t.includes("{label}"));
  for (const t of platformTags) if (!ownTags.includes(t)) unread.push(`the per-platform tag ${t}, which names no version`);
  return { name, repository, dockerfile: dockerfile ?? "Dockerfile", platforms, args, labels, tags, platformTags: ownTags, archive: imageArchiveBesideGoreleaser(name), keys, unread };
}
