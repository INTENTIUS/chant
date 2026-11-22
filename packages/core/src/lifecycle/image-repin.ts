/**
 * Re-pinning image references to the digest their tag names today (#5457).
 *
 * A reference pinned by digest keeps the tag it followed beside it:
 * `node:22-bookworm-slim@sha256:<digest>`. Re-pinning asks the registry what
 * index digest the tag names now and, when it moved, rewrites the digest in
 * place, keeping the tag. Nothing else in the file changes, and a reference
 * whose tag still names the same digest is left as it is, so a run with
 * nothing to move writes nothing.
 *
 * {@link pinnedReferences} finds two shapes in any text file:
 *
 * - `<name>:<tag>@sha256:<digest>`, as a Dockerfile's `FROM` and `ARG`
 *   defaults, and chant's `CI_BASE_IMAGES`, write it;
 * - `pin("<repository>", "<tag>", "sha256:<digest>")`, a row of chant's
 *   `IMAGE_PINS`.
 *
 * A reference with a digest and no tag has nothing to follow and is left. A
 * `FROM` by tag alone is not re-pinned either: the `supply-chain` check
 * reports it, and pinning it the first time is a person's choice of digest.
 *
 * `chant release images --repin` runs it on the Dockerfiles `release.images`
 * names, or on the files it is given, such as chant's own
 * `packages/core/src/image-pins.ts` and `packages/core/src/ci-image.ts`, and
 * prints what moved so a scheduled job can open a pull request with it.
 */

import { ociCredential, parseRepository, Registry } from "./publish-oci";
import { createRedactor } from "./publish-credentials";
import type { PublishFetch } from "./release-publish";

/** One pinned reference in a file. */
export interface PinnedReference {
  /** Where the digest starts in the text, and the digest as written. */
  at: number;
  digest: string;
  /** The line it is on, from 1. */
  line: number;
  repository: string;
  tag: string;
}

/** `<name>:<tag>@sha256:<digest>`, with an optional registry host and port. */
const REFERENCE = /(?<![A-Za-z0-9._/:@-])((?:[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*):([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})@(sha256:[0-9a-f]{64})/g;
/** `pin("<repository>", "<tag>", "sha256:<digest>")`. */
const PIN_CALL = /\bpin\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"(sha256:[0-9a-f]{64})"\s*\)/g;

/** Every pinned reference in `text` that names a tag, in the order they appear. */
export function pinnedReferences(text: string): PinnedReference[] {
  const lineOf = (at: number) => text.slice(0, at).split("\n").length;
  const out: PinnedReference[] = [];
  for (const m of text.matchAll(REFERENCE)) {
    const at = m.index! + m[0].length - m[3]!.length;
    out.push({ at, digest: m[3]!, line: lineOf(at), repository: m[1]!, tag: m[2]! });
  }
  for (const m of text.matchAll(PIN_CALL)) {
    const at = m.index! + m[0].lastIndexOf(m[3]!);
    out.push({ at, digest: m[3]!, line: lineOf(at), repository: m[1]!, tag: m[2]! });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Resolves `<repository>:<tag>` to the digest of the manifest or index the tag names now. */
export type ImageResolver = (repository: string, tag: string) => Promise<string>;

/**
 * An {@link ImageResolver} that asks each image's registry, with a pull-only
 * token. Credentials come from `OCI_USERNAME` and `OCI_PASSWORD`, else the
 * docker config's `auths` entry for the registry; with none, it asks
 * anonymously, which public images allow.
 */
export function registryResolver(env: NodeJS.ProcessEnv, fetchImpl: PublishFetch = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<PublishFetch>): ImageResolver {
  const redactor = createRedactor(env);
  return async (repository, tag) => {
    const repo = parseRepository(repository);
    const cred = ociCredential({}, repo, { env, redactor });
    const registry = new Registry(repo, fetchImpl, cred, { cwd: ".", env, redactor, log: () => undefined, provenance: { oidc: false, ci: null, reason: "" }, tag: null });
    registry.actions = "pull";
    const found = await registry.getManifest(tag);
    if (!found) throw new Error(`${repository}:${tag} is not in ${repo.base}`);
    return found.digest;
  };
}

/** One reference whose tag names another digest now. */
export interface RepinMove {
  file: string;
  line: number;
  /** `<repository>:<tag>`. */
  reference: string;
  from: string;
  to: string;
}

/** What a re-pin did. */
export interface RepinResult {
  /** Each file with its text after the re-pin, and whether it changed. */
  files: Array<{ path: string; text: string; changed: boolean }>;
  moved: RepinMove[];
  /** How many references still name the digest their tag names. */
  unchanged: number;
  /** References whose tag could not be resolved, and why; their digests are left. */
  failed: Array<{ file: string; line: number; reference: string; reason: string }>;
}

/** Re-pin every reference in `files` with `resolve`, asking once per `<repository>:<tag>`. */
export async function repinFiles(files: ReadonlyArray<{ path: string; text: string }>, resolve: ImageResolver): Promise<RepinResult> {
  const cache = new Map<string, Promise<string>>();
  const ask = (repository: string, tag: string) => {
    const key = `${repository}:${tag}`;
    let p = cache.get(key);
    if (!p) {
      p = resolve(repository, tag);
      cache.set(key, p);
    }
    return p;
  };
  const result: RepinResult = { files: [], moved: [], unchanged: 0, failed: [] };
  for (const file of files) {
    let text = file.text;
    const moved: RepinMove[] = [];
    const failed: RepinResult["failed"] = [];
    // Rewrite from the end, so an earlier reference's offset is not moved by a later one.
    for (const ref of pinnedReferences(file.text).reverse()) {
      const reference = `${ref.repository}:${ref.tag}`;
      let now: string;
      try {
        now = await ask(ref.repository, ref.tag);
      } catch (err) {
        failed.unshift({ file: file.path, line: ref.line, reference, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (now === ref.digest) {
        result.unchanged++;
        continue;
      }
      text = text.slice(0, ref.at) + now + text.slice(ref.at + ref.digest.length);
      moved.unshift({ file: file.path, line: ref.line, reference, from: ref.digest, to: now });
    }
    result.moved.push(...moved);
    result.failed.push(...failed);
    result.files.push({ path: file.path, text, changed: text !== file.text });
  }
  return result;
}
