/**
 * #5451: the Wiz image scanner in the release scan gate. `wizcli` is a shell
 * script that writes a recorded SARIF file; Wiz is never called.
 */
import { afterAll, describe, expect, test } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChantConfigSchema } from "../config";
import { createRedactor } from "./publish-credentials";
import { PublishDeclarationSchema } from "./publish-declaration";
import { resolveScan } from "./publish-scan";
import { withImageScanner, wizImageArgs, wizReleaseScanner, WIZ_CREDENTIALS } from "./publish-scan-wiz";
import { createPublishTargets } from "./publish-targets";
import { PublishRunError, runPublish, type PublishContext } from "./release-publish";
import { makeRelease, type ReleaseArtifact } from "./release-store";
import { startFakeRegistry, writeLockfile, writeOciLayout, writePackage } from "./__fixtures__/publish-fakes";
import { fakeReleaseScanner } from "./__fixtures__/scan-fakes";

const SCANNERS = join(__dirname, "..", "components", "__fixtures__", "scanners");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "chant-wiz-scan-"));
  dirs.push(d);
  return d;
};

/** A fake `wizcli` in `dir`: `auth` and `version` succeed, `docker scan` writes `sarif` where -o says and exits `exit`. Its calls go to `calls.txt`. */
function fakeWizcli(dir: string, sarif: string | null, exit = 0): string {
  const bin = join(dir, "wizcli");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `echo "$@" >> "${join(dir, "calls.txt")}"`,
      `if [ "$1" = version ]; then echo "wizcli 1.2.3"; exit 0; fi`,
      `if [ "$1" = docker ]; then`,
      `  while [ $# -gt 0 ]; do case "$1" in --image-tarball) tar="$2";; -o) out="\${2%,sarif}";; esac; shift; done`,
      `  [ -e "$tar" ] || { echo "no image at $tar" >&2; exit 2; }`,
      sarif ? `  cp "${join(SCANNERS, sarif)}" "$out"` : "  :",
      `  exit ${exit}`,
      `fi`,
    ].join("\n") + "\n",
  );
  chmodSync(bin, 0o755);
  return bin;
}

const CREDS = { WIZ_CLIENT_ID: "id-fake", WIZ_CLIENT_SECRET: "secret-fake" };

function context(cwd: string, scan: PublishContext["scan"], env: Record<string, string>): PublishContext {
  const release = makeRelease({ member: null, commit: "c0ffee".padEnd(40, "0"), artifactDigests: [] as ReleaseArtifact[], targets: [{ env: "dev", params: [], templates: [] }] });
  return { release, label: "v1.4.0", releaseTag: "release/v1.4.0", provenance: { oidc: true, ci: "github", reason: "" }, cwd, tag: null, env, redactor: createRedactor(env), log: () => undefined, scan };
}

async function publishImage(sarif: string | null, exit = 0, creds: Record<string, string> = CREDS) {
  const reg = await startFakeRegistry({ username: "robot", password: "pw-wiz-1", token: "tok-wiz-1" });
  const dir = temp();
  writeOciLayout(join(dir, "image"));
  writeLockfile(dir);
  const bin = fakeWizcli(dir, sarif, exit);
  const env = { OCI_USERNAME: "robot", OCI_PASSWORD: "pw-wiz-1", CHANT_WIZCLI: bin, ...creds };
  const base = fakeReleaseScanner();
  const scanner = withImageScanner({ imageScanner: "wiz" }, env, base, { redactor: createRedactor(env) });
  const targets = await createPublishTargets([PublishDeclarationSchema.parse({ type: "oci", image: "image", repository: `${reg.host}/acme/api` })], {});
  const ctx = context(dir, { scanner, policy: {}, vex: [] }, env);
  const result = await runPublish({ cwd: dir, release: ctx.release, label: ctx.label, targets, ctx, record: false }).then(
    (run) => ({ run, err: null as unknown }),
    (err: unknown) => ({ run: null, err }),
  );
  return { reg, dir, base, scanner, ...result };
}

describe("release.scan.imageScanner", () => {
  test("is read from chant.config.ts and resolves with the setting", () => {
    expect(ChantConfigSchema.safeParse({ release: { scan: { imageScanner: "wiz" } } }).success).toBe(true);
    expect(ChantConfigSchema.safeParse({ release: { scan: { imageScanner: "other" } } }).success).toBe(false);
    expect(resolveScan({ imageScanner: "wiz", db: "d" }, new Set())).toMatchObject({ on: true, from: "config", db: "d", imageScanner: "wiz" });
    expect(resolveScan(true, new Set()).imageScanner).toBeUndefined();
  });
});

describe("the Wiz image scanner in the release gate", () => {
  test("an image Wiz reports a critical CVE in stops the publish, and nothing reaches the registry", async () => {
    const { reg, err, dir, base } = await publishImage("wiz-image.sarif");
    try {
      expect(err).toBeInstanceOf(PublishRunError);
      expect(err).toMatchObject({ code: "publish-scan-failed", step: "scan", staged: [], revealed: [] });
      expect((err as Error).message).toContain("CVE-2026-50002 (critical) in debian/openssl 3.0.11-1, fixed in 3.0.15-1");
      expect((err as Error).message).not.toContain("CVE-2026-50003");
      expect((err as Error).message).toContain("wizcli v1.2.3 for images");
      // Wiz scanned the image, not grype: the base scanner only made the layer SBOM.
      expect(base.calls.filter((c) => c.startsWith("scan "))).toEqual([]);
      const call = readFileSync(join(dir, "calls.txt"), "utf-8").split("\n").find((l) => l.startsWith("docker scan"))!;
      expect(call).toMatch(/^docker scan --image-tarball \S+image\.tar -o \S+wiz\.sarif,sarif$/);
      expect(reg.requests).toEqual([]);
      expect(reg.manifests.size).toBe(0);
    } finally {
      await reg.close();
    }
  });

  test("an image Wiz finds clean stages, and the findings go on the record", async () => {
    const { reg, run, err } = await publishImage("wiz-image-clean.sarif");
    try {
      expect(err).toBeNull();
      expect(run!.scan?.scanner).toContain("wizcli v1.2.3");
      expect(run!.scan?.subjects.map((s) => s.findings.length)).toEqual([0]);
      expect(reg.manifests.size).toBeGreaterThan(0);
    } finally {
      await reg.close();
    }
  });

  test("wizcli exiting non-zero for its own policy still hands chant's gate the findings it wrote", async () => {
    const { reg, err } = await publishImage("wiz-image.sarif", 3);
    try {
      expect(err).toMatchObject({ code: "publish-scan-failed" });
    } finally {
      await reg.close();
    }
  });

  test("wizcli writing no results is a tool failure, never an empty scan", async () => {
    const { reg, err } = await publishImage(null, 1);
    try {
      expect(err).toMatchObject({ code: "publish-scan-tool-failed" });
      expect((err as Error).message).toContain("wizcli did not write results");
      expect(reg.manifests.size).toBe(0);
    } finally {
      await reg.close();
    }
  });

  test("an SBOM a package carries is scanned by the wrapped scanner, since Wiz scans images", async () => {
    const dir = temp();
    writePackage(join(dir, "pkg"), "@acme/core", "1.4.0", false, { "left-pad": "^1.3.0" });
    writeLockfile(dir);
    const env = { CHANT_WIZCLI: fakeWizcli(dir, "wiz-image-clean.sarif"), ...CREDS };
    const base = fakeReleaseScanner();
    const scanner = wizReleaseScanner(env, base);
    const targets = await createPublishTargets([PublishDeclarationSchema.parse({ type: "npm", packages: ["pkg"] })], {});
    const err = await runPublish({ cwd: dir, release: context(dir, null, env).release, label: "v1.4.0", targets, ctx: context(dir, { scanner, policy: {}, vex: [] }, env), record: false }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "publish-scan-failed" });
    expect(base.calls).toEqual(["scan lockfile"]);
    expect(readFileSync(join(dir, "calls.txt"), "utf-8")).not.toContain("docker");
  });
});

describe("what Wiz needs before the publish scans", () => {
  test("without its credentials the publish refuses, naming them, and does not scan with the other scanner", () => {
    const dir = temp();
    const env = { CHANT_WIZCLI: fakeWizcli(dir, null), WIZ_CLIENT_ID: "id-fake" };
    const scanner = wizReleaseScanner(env, fakeReleaseScanner());
    expect(scanner.unavailable({ images: true })).toMatch(/WIZ_CLIENT_SECRET is not set/);
    expect(scanner.unavailable({ images: true })).not.toContain("WIZ_CLIENT_ID is");
    expect(WIZ_CREDENTIALS).toEqual(["WIZ_CLIENT_ID", "WIZ_CLIENT_SECRET"]);
  });

  test("a missing wizcli, or a missing syft or grype under it, is named", () => {
    expect(wizReleaseScanner({ ...CREDS, CHANT_WIZCLI: "/nonexistent/wizcli" }, fakeReleaseScanner()).unavailable({ images: true })).toMatch(/not there: install the Wiz CLI/);
    const dir = temp();
    const env = { CHANT_WIZCLI: fakeWizcli(dir, null), ...CREDS };
    expect(wizReleaseScanner(env, fakeReleaseScanner()).unavailable({ images: true })).toBeNull();
    expect(wizReleaseScanner(env, fakeReleaseScanner({ missing: "syft is not there" })).unavailable({ images: true })).toBe("syft is not there");
  });

  test("a secret that appears in wizcli's error is redacted", async () => {
    const dir = temp();
    const bin = join(dir, "wizcli");
    writeFileSync(bin, `#!/bin/sh\nif [ "$1" = version ]; then echo 1.0.0; exit 0; fi\necho "auth failed for secret-fake" >&2\nexit 1\n`);
    chmodSync(bin, 0o755);
    const env = { CHANT_WIZCLI: bin, ...CREDS };
    const scanner = wizReleaseScanner(env, fakeReleaseScanner(), { redactor: createRedactor({ ...env }, ["WIZ_CLIENT_SECRET"]) });
    const sbom = await scanner.imageSbom(dir);
    await expect(scanner.scan(sbom)).rejects.toThrow(/did not write results/);
    await expect(scanner.scan(sbom)).rejects.not.toThrow(/secret-fake/);
  });

  test("the arguments name the archive and ask for SARIF", () => {
    expect(wizImageArgs("/a/image.tar", "/o/wiz.sarif")).toEqual(["docker", "scan", "--image-tarball", "/a/image.tar", "-o", "/o/wiz.sarif,sarif"]);
  });
});
