/**
 * Real `ReferrerLookup` backend (#610, epic #551 follow-up to #568's
 * `ReferrerLookup` interface). Shells out to `oras discover --format json
 * <digest>` — the OCI distribution spec's referrers API, as exposed by the
 * `oras` CLI — through the same injectable `ProcessRunner`
 * (../components/verbs/process-runner.ts) the deep-scan `SbomGenerator`
 * backend (../components/verbs/tool-sbom-generator.ts) and `publish-image`'s
 * referrer-attach step share, mirroring ../components/verbs/cloud-executor.ts's
 * `CloudExecutor` pattern once more: production code shells out, tests inject
 * a `MockProcessRunner` and never touch a real registry/`oras` binary.
 *
 * Not the process-wide default: ./build-ledger.ts's `noopReferrerLookup`
 * remains that (reports no referrers, no network, no registry credentials
 * required) for exactly the reason `notImplementedSbomGenerator` and
 * `SbomGenerator`'s hermetic backend aren't `sbom-generator.ts`'s default
 * either — a project opts into the real registry-backed lookup explicitly
 * (`buildLedgerEntries(manifest, createOrasReferrerLookup())`) rather than
 * every previously-network-free build-ledger query silently starting to hit
 * a registry.
 */

import {
  defaultProcessRunner,
  q,
  requireTool,
  type ProcessRunner,
} from "../components/verbs/process-runner";
import type { Referrer, ReferrerKind, ReferrerLookup } from "./build-ledger";

/** Shape of one entry in `oras discover --format json`'s `manifests[]` array — the fields this module actually reads, not oras's full manifest descriptor. */
interface OrasManifestDescriptor {
  digest: string;
  mediaType: string;
  /** oras nests the referrer's own artifact type here for a referrers-API-discovered entry. */
  artifactType?: string;
  annotations?: Record<string, string>;
}

/** Shape of `oras discover --format json <ref>`'s top-level output. */
interface OrasDiscoverOutput {
  manifests?: OrasManifestDescriptor[];
}

/**
 * Classify one oras-reported referrer manifest into a `ReferrerKind`, keyed
 * off its `artifactType`/media type — the same three kinds
 * ../components/verbs/build-ledger.ts's `Referrer.kind` already models
 * (`sbom`, `provenance`, `signature`). An unrecognized artifact type is
 * skipped (returns `undefined`) rather than guessed at, since a wrong
 * classification (e.g. reporting a signature as an SBOM) would be worse than
 * omitting it — the caller only ever sees referrers this module is confident
 * about.
 */
function classify(descriptor: OrasManifestDescriptor): ReferrerKind | undefined {
  const type = (descriptor.artifactType ?? descriptor.mediaType ?? "").toLowerCase();
  if (type.includes("spdx") || type.includes("cyclonedx") || type.includes("sbom")) return "sbom";
  if (type.includes("in-toto") || type.includes("provenance") || type.includes("slsa")) return "provenance";
  if (type.includes("cosign") || type.includes("signature") || type.includes("sig.")) return "signature";
  return undefined;
}

export interface OrasReferrerLookupOptions {
  /** Injected process boundary. Defaults to the real, `child_process`-backed runner. */
  runner?: ProcessRunner;
  /** Registry/repo prefix `digest` is resolved against (e.g. `123.dkr.ecr.us-east-1.amazonaws.com/search`) — `oras discover` needs a full `repo@digest` reference, not a bare digest. Required; a `ReferrerLookup.discover(digest)` call with no repo context has nothing to query. */
  repo: string;
}

/**
 * Build a real `ReferrerLookup` backed by `oras discover`. `discover(digest)`
 * runs `oras discover --format json <repo>@<digest>` and maps every returned
 * manifest into a `Referrer`, classified by `classify` above. Returns `[]`
 * (never throws) when `oras` reports no referrers for a digest — an image
 * with no attached SBOM/provenance/signature is a normal outcome, not an
 * error. Throws `ToolNotAvailableError`
 * (../components/verbs/process-runner.ts) if `oras` itself is not installed,
 * so a misconfigured environment fails loudly rather than silently reporting
 * "no referrers" for every digest.
 */
export function createOrasReferrerLookup(options: OrasReferrerLookupOptions): ReferrerLookup {
  const runner = options.runner ?? defaultProcessRunner();

  return {
    async discover(digest: string): Promise<Referrer[]> {
      await requireTool(runner, "oras", `discover OCI referrers for ${options.repo}@${digest}`);
      const ref = `${options.repo.replace(/\/+$/, "")}@${digest}`;
      const { stdout } = await runner.run(`oras discover --format json ${q(ref)}`);

      let parsed: OrasDiscoverOutput;
      try {
        parsed = JSON.parse(stdout) as OrasDiscoverOutput;
      } catch {
        return []; // no referrers / unexpected output shape — degrade to "none known", never throw on a parse hiccup.
      }

      const referrers: Referrer[] = [];
      for (const descriptor of parsed.manifests ?? []) {
        const kind = classify(descriptor);
        if (!kind) continue;
        referrers.push({
          kind,
          mediaType: descriptor.artifactType ?? descriptor.mediaType,
          digest: descriptor.digest,
          location: `${options.repo}@${descriptor.digest}`,
        });
      }
      return referrers;
    },
  };
}
