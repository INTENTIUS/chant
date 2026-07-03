/**
 * Tests the real `ReferrerLookup` backend (#610, ./oras-referrer-lookup.ts)
 * against a `MockProcessRunner`
 * (../components/verbs/__tests__/mock-process-runner.ts) — no live `oras`,
 * no live registry. Asserts the `oras discover` command constructed, that
 * its JSON output is parsed and classified into `Referrer[]`, and that a
 * missing `oras` binary surfaces `ToolNotAvailableError`.
 */

import { describe, expect, it } from "vitest";
import { createOrasReferrerLookup } from "./oras-referrer-lookup";
import { ToolNotAvailableError } from "../components/verbs/process-runner";
import { createMockProcessRunner } from "../components/verbs/__tests__/mock-process-runner";

const REPO = "123.dkr.ecr.us-east-1.amazonaws.com/search";
const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function orasOutput(manifests: Array<{ digest: string; mediaType: string; artifactType?: string }>): string {
  return JSON.stringify({ manifests });
}

describe("createOrasReferrerLookup (#610)", () => {
  it("constructs the oras discover command against repo@digest", async () => {
    const mock = createMockProcessRunner({ responses: { "oras discover": orasOutput([]) } });
    const lookup = createOrasReferrerLookup({ repo: REPO, runner: mock.runner });

    await lookup.discover(DIGEST);

    const call = mock.calls.find((c) => c.command.startsWith("oras discover"))!;
    expect(call.command).toBe(`oras discover --format json '${REPO}@${DIGEST}'`);
  });

  it("classifies an spdx/cyclonedx manifest as an sbom referrer", async () => {
    const mock = createMockProcessRunner({
      responses: {
        "oras discover": orasOutput([
          { digest: "sha256:sbom1", mediaType: "application/vnd.oci.image.manifest.v1+json", artifactType: "application/spdx+json" },
        ]),
      },
    });
    const lookup = createOrasReferrerLookup({ repo: REPO, runner: mock.runner });

    const referrers = await lookup.discover(DIGEST);

    expect(referrers).toEqual([
      { kind: "sbom", mediaType: "application/spdx+json", digest: "sha256:sbom1", location: `${REPO}@sha256:sbom1` },
    ]);
  });

  it("classifies an in-toto/slsa manifest as a provenance referrer", async () => {
    const mock = createMockProcessRunner({
      responses: {
        "oras discover": orasOutput([
          { digest: "sha256:prov1", mediaType: "application/vnd.oci.image.manifest.v1+json", artifactType: "application/vnd.in-toto+json" },
        ]),
      },
    });
    const lookup = createOrasReferrerLookup({ repo: REPO, runner: mock.runner });

    const referrers = await lookup.discover(DIGEST);
    expect(referrers[0]?.kind).toBe("provenance");
  });

  it("classifies a cosign signature manifest as a signature referrer", async () => {
    const mock = createMockProcessRunner({
      responses: {
        "oras discover": orasOutput([
          { digest: "sha256:sig1", mediaType: "application/vnd.dev.cosign.simplesigning.v1+json", artifactType: "application/vnd.dev.cosign.signature" },
        ]),
      },
    });
    const lookup = createOrasReferrerLookup({ repo: REPO, runner: mock.runner });

    const referrers = await lookup.discover(DIGEST);
    expect(referrers[0]?.kind).toBe("signature");
  });

  it("skips a manifest of an unrecognized artifact type rather than guessing", async () => {
    const mock = createMockProcessRunner({
      responses: {
        "oras discover": orasOutput([
          { digest: "sha256:unknown1", mediaType: "application/vnd.acme.something+json", artifactType: "application/vnd.acme.something+json" },
        ]),
      },
    });
    const lookup = createOrasReferrerLookup({ repo: REPO, runner: mock.runner });

    expect(await lookup.discover(DIGEST)).toEqual([]);
  });

  it("returns [] when oras reports no manifests", async () => {
    const mock = createMockProcessRunner({ responses: { "oras discover": orasOutput([]) } });
    const lookup = createOrasReferrerLookup({ repo: REPO, runner: mock.runner });
    expect(await lookup.discover(DIGEST)).toEqual([]);
  });

  it("returns [] rather than throwing on unparseable oras output", async () => {
    const mock = createMockProcessRunner({ responses: { "oras discover": "not json" } });
    const lookup = createOrasReferrerLookup({ repo: REPO, runner: mock.runner });
    expect(await lookup.discover(DIGEST)).toEqual([]);
  });

  it("throws ToolNotAvailableError when oras is not installed", async () => {
    const mock = createMockProcessRunner({ tools: { oras: false } });
    const lookup = createOrasReferrerLookup({ repo: REPO, runner: mock.runner });
    await expect(lookup.discover(DIGEST)).rejects.toThrow(ToolNotAvailableError);
  });

  it("strips a trailing slash from repo before composing the reference", async () => {
    const mock = createMockProcessRunner({ responses: { "oras discover": orasOutput([]) } });
    const lookup = createOrasReferrerLookup({ repo: `${REPO}/`, runner: mock.runner });
    await lookup.discover(DIGEST);
    const call = mock.calls.find((c) => c.command.startsWith("oras discover"))!;
    expect(call.command).toContain(`${REPO}@${DIGEST}`);
  });
});
