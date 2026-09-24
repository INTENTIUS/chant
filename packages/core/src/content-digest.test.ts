/**
 * chant #2514 — `contentDigest` is real SHA-256 over UTF-8, and the manifest
 * and SBOM digests built on it separate inputs one byte apart.
 */
import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { contentDigest } from "./content-digest";
import { canonicalJson } from "./effect-receipt";
import {
  addArchiveEntry,
  computeManifestDigest,
  contentDigest as archiveContentDigest,
  createBuildArchiveManifest,
} from "./components/verbs/build-archive";
import { createGenerateSbomCapability } from "./components/verbs/sbom";
import type { SbomDocument, SbomGenerator } from "./components/verbs/sbom-generator";
import { computePlanDigest } from "./lifecycle/plan-digest";
import { hashProps } from "./lifecycle/digest";
import { isLegacyContentDigest } from "./lifecycle/legacy-digest";

describe("contentDigest (#2514)", () => {
  test("matches the FIPS 180-2 test vectors", () => {
    expect(contentDigest("abc")).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(contentDigest("")).toBe("sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("hashes the UTF-8 bytes, not UTF-16 code units", () => {
    const text = "héllo, 世界 🌍";
    const expected = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
    expect(contentDigest(text)).toBe(`sha256:${expected}`);
  });

  test("the build archive exports the same function", () => {
    expect(archiveContentDigest).toBe(contentDigest);
  });

  test("its output is never mistaken for the old form", () => {
    for (const input of ["", "x", "hello", "{}"]) {
      expect(isLegacyContentDigest(contentDigest(input))).toBe(false);
    }
  });

  test("inputs one byte apart get different digests", () => {
    expect(contentDigest("template-a")).not.toBe(contentDigest("template-b"));
    expect(contentDigest("abc")).not.toBe(contentDigest("abc "));
  });
});

describe("manifest digest (#2514)", () => {
  const entry = (digest: string, path = "web.json") => ({ kind: "template" as const, path, digest });

  test("is contentDigest over the canonical JSON of the sorted entries", () => {
    const a = entry(contentDigest("{}"), "b.json");
    const b = entry(contentDigest("[]"), "a.json");
    const expected = contentDigest(
      canonicalJson([
        { kind: b.kind, path: b.path, digest: b.digest },
        { kind: a.kind, path: a.path, digest: a.digest },
      ]),
    );
    expect(computeManifestDigest([a, b])).toBe(expected);
    expect(computeManifestDigest([b, a])).toBe(expected);
  });

  test("templates one byte apart give different entry and manifest digests", () => {
    const base = createBuildArchiveManifest("web", { now: () => new Date(0) });
    const one = addArchiveEntry(base, entry(contentDigest('{"Resources":{"A":1}}')));
    const two = addArchiveEntry(base, entry(contentDigest('{"Resources":{"A":2}}')));
    expect(one.contents[0]!.digest).not.toBe(two.contents[0]!.digest);
    expect(one.manifestDigest).not.toBe(two.manifestDigest);
  });

  test("a path cannot be read as a separator", () => {
    // Under the old `kind:path:digest` join these two could be confused.
    const x = computeManifestDigest([entry("sha256:1", "a:template:b")]);
    const y = computeManifestDigest([entry("template:b:sha256:1", "a")]);
    expect(x).not.toBe(y);
  });
});

describe("SBOM digest (#2514)", () => {
  function fixedGenerator(bytes: string): SbomGenerator {
    const doc = async (): Promise<SbomDocument> => ({
      format: "spdx",
      mediaType: "application/spdx+json",
      bytes,
      generator: "test",
    });
    return { forImage: doc, forJar: doc, forZip: doc, forDir: doc };
  }

  test("SBOMs one byte apart get different digests, each real SHA-256", async () => {
    const ctx = { env: "dev", component: "web" };
    const input = { artifactType: "image" as const, path: "archive/web.tar", digest: contentDigest("image") };
    const a = await createGenerateSbomCapability(fixedGenerator('{"packages":[1]}')).run(ctx, input);
    const b = await createGenerateSbomCapability(fixedGenerator('{"packages":[2]}')).run(ctx, input);
    expect(a.digest).toBe(contentDigest('{"packages":[1]}'));
    expect(a.digest).not.toBe(b.digest);
    expect(a.manifest.manifestDigest).not.toBe(b.manifest.manifestDigest);
  });
});

describe("other hashes use contentDigest over canonicalJson (#2514)", () => {
  test("a plan digest", () => {
    const subject = { b: 1, a: [true, null] };
    expect(computePlanDigest("lifecycle-diff", subject)).toBe(
      contentDigest(canonicalJson({ kind: "lifecycle-diff", subject })),
    );
  });

  test("a plan digest orders keys by code unit, not by locale", () => {
    // localeCompare puts "a" before "B"; canonicalJson puts "B" first.
    expect(computePlanDigest("k", { a: 1, B: 2 })).toBe(contentDigest('{"kind":"k","subject":{"B":2,"a":1}}'));
  });

  test("a props hash, which drops what JSON cannot hold instead of throwing", () => {
    const props = { Name: "x", fn: () => 1, nested: { z: 1, a: undefined } };
    expect(hashProps(props)).toBe(contentDigest('{"Name":"x","nested":{"z":1}}').slice("sha256:".length));
  });
});
