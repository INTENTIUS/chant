/**
 * #5232: the Maven Central target, against a fake Central Portal (upload,
 * status, publish) and a fake repository. The stage uploads and waits for
 * validation; the reveal publishes the deployment. Nothing reaches a network.
 */

import { afterAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formFile, publishContext, refusal, reply, sha256, zipOf } from "./__fixtures__/package-files";
import { MavenPublishSchema } from "./publish-declaration";
import { pomDependencies, readMavenBundle } from "./publish-maven";
import { zipEntryNames } from "./publish-pypi";
import { createPublishTargets } from "./publish-targets";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const POM = `<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>dev.arugula</groupId>
  <artifactId>kit</artifactId>
  <version>1.2.0</version>
  <dependencies>
    <dependency><groupId>dev.arugula</groupId><artifactId>core</artifactId><version>1.2.0</version></dependency>
    <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.10.0</version><scope>test</scope></dependency>
  </dependencies>
  <build><plugins><plugin><groupId>x</groupId><artifactId>y</artifactId><dependencies><dependency><groupId>p</groupId><artifactId>q</artifactId></dependency></dependencies></plugin></plugins></build>
</project>`;

const BASE = "dev/arugula/kit/1.2.0";

/** A staging directory in Maven repository layout. */
function member(opts: { unsigned?: boolean; sbom?: boolean; snapshot?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "chant-publish-maven-"));
  dirs.push(dir);
  const v = opts.snapshot ? "1.2.0-SNAPSHOT" : "1.2.0";
  const base = `dev/arugula/kit/${v}`;
  const files: Record<string, string> = {
    [`${base}/kit-${v}.pom`]: POM,
    [`${base}/kit-${v}.pom.asc`]: "sig",
    [`${base}/kit-${v}.jar`]: "PK-jar",
    ...(opts.unsigned ? {} : { [`${base}/kit-${v}.jar.asc`]: "sig" }),
    ...(opts.sbom ? { [`${base}/kit-${v}-cyclonedx.json`]: "{}", [`${base}/kit-${v}-cyclonedx.json.asc`]: "sig" } : {}),
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, "staging", dirname(p)), { recursive: true });
    writeFileSync(join(dir, "staging", p), text);
  }
  return dir;
}

/** A fake Central Portal and repository. */
function fakeCentral(opts: { served?: string; validation?: string[] } = {}) {
  const uploads: Array<{ auth: string; query: string; names: string[] }> = [];
  const published: string[] = [];
  const states = [...(opts.validation ?? ["PENDING", "VALIDATING", "VALIDATED"])];
  let state = "NONE";
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array | string }) => {
    if (init.method === "GET" && url === `https://repo1.maven.org/maven2/${BASE}/kit-1.2.0.pom`) return opts.served !== undefined ? reply(200, opts.served) : reply(404);
    const auth = init.headers.authorization ?? "";
    if (url.startsWith("https://central.sonatype.com/") && auth !== `Bearer ${Buffer.from("tok-user:tok-pass").toString("base64")}`) return reply(401, "Unauthorized");
    if (init.method === "POST" && url.startsWith("https://central.sonatype.com/api/v1/publisher/upload?")) {
      const f = formFile(init.body as Uint8Array, init.headers["content-type"]!);
      uploads.push({ auth, query: url.split("?")[1]!, names: zipEntryNames(f.bytes) });
      state = states.shift() ?? "VALIDATED";
      return reply(201, "dep-123");
    }
    if (init.method === "POST" && url === "https://central.sonatype.com/api/v1/publisher/status?id=dep-123") {
      const now = state;
      if (states.length > 0) state = states.shift()!;
      return reply(200, JSON.stringify({ deploymentId: "dep-123", deploymentState: now, ...(now === "FAILED" ? { errors: { "pkg:maven/dev.arugula/kit@1.2.0": ["Invalid signature"] } } : {}) }));
    }
    if (init.method === "POST" && url === "https://central.sonatype.com/api/v1/publisher/deployment/dep-123") {
      published.push("dep-123");
      state = "PUBLISHING";
      return reply(204);
    }
    return reply(404);
  };
  return { fetch, uploads, published };
}

const env = { MAVEN_CENTRAL_USERNAME: "tok-user", MAVEN_CENTRAL_PASSWORD: "tok-pass" };
const decl = (d: Record<string, unknown> = {}) => MavenPublishSchema.parse({ type: "maven", bundle: "staging", ...d });
const deps = (fetch: ReturnType<typeof fakeCentral>["fetch"]) => ({ fetch, sleep: async () => {}, now: () => 0 });

describe("maven (#5232)", () => {
  test("reads a staging directory, adding checksums, and a pom's run-time dependencies", () => {
    const dir = member();
    const b = readMavenBundle(publishContext(dir, {}), "staging");
    expect(b.components).toMatchObject([{ groupId: "dev.arugula", artifactId: "kit", version: "1.2.0" }]);
    expect([...b.files.keys()]).toContain(`${BASE}/kit-1.2.0.jar.sha1`);
    expect([...b.files.keys()]).not.toContain(`${BASE}/kit-1.2.0.jar.asc.md5`);
    expect(readMavenBundle(publishContext(dir, {}), "staging").digest).toBe(b.digest);
    expect(pomDependencies(POM)).toEqual(["dev.arugula:core"]);
  });

  test("a zip bundle is read as it is", () => {
    const dir = member();
    writeFileSync(join(dir, "bundle.zip"), zipOf({ [`${BASE}/kit-1.2.0.pom`]: POM, [`${BASE}/kit-1.2.0.pom.asc`]: "sig" }));
    expect(readMavenBundle(publishContext(dir, {}), "bundle.zip").components).toHaveLength(1);
  });

  test("the stage uploads for the user to publish and waits for validation; the reveal publishes", async () => {
    const dir = member();
    const central = fakeCentral();
    const [t] = await createPublishTargets([decl()], deps(central.fetch));
    const ctx = publishContext(dir, env);
    const staged = await t!.stage(ctx);
    expect(central.uploads).toHaveLength(1);
    expect(central.uploads[0]!.query).toContain("publishingType=USER_MANAGED");
    expect(central.uploads[0]!.names).toContain(`${BASE}/kit-1.2.0.pom.md5`);
    expect(staged.state).toEqual({ deployment: "dep-123" });
    expect(staged.items).toEqual([{ name: "dev.arugula:kit@1.2.0", destination: "https://central.sonatype.com/artifact/dev.arugula/kit/1.2.0", digest: `sha256:${sha256(Buffer.from(POM))}` }]);
    expect(central.published).toEqual([]);
    await t!.reveal(ctx, staged);
    expect(central.published).toEqual(["dep-123"]);
    // A reveal run again finds the deployment publishing and sends nothing.
    await t!.reveal(ctx, staged);
    expect(central.published).toEqual(["dep-123"]);
    expect(ctx.lines.join("\n")).not.toContain(Buffer.from("tok-user:tok-pass").toString("base64"));
  });

  test("a component the repository serves with the same pom is present; with another it is refused", async () => {
    const dir = member();
    const same = fakeCentral({ served: POM });
    const [t] = await createPublishTargets([decl()], deps(same.fetch));
    const staged = await t!.stage(publishContext(dir, env));
    expect(staged.state).toEqual({ present: "true" });
    expect(same.uploads).toHaveLength(0);
    const other = fakeCentral({ served: "<project/>" });
    const [u] = await createPublishTargets([decl()], deps(other.fetch));
    expect((await refusal(u!.stage(publishContext(dir, env)))).code).toBe("publish-maven-version-exists");
  });

  test("a deployment the Portal fails is refused with its errors", async () => {
    const dir = member();
    const central = fakeCentral({ validation: ["VALIDATING", "FAILED"] });
    const [t] = await createPublishTargets([decl()], deps(central.fetch));
    const err = await refusal(t!.stage(publishContext(dir, env)));
    expect(err.code).toBe("publish-maven-invalid");
    expect(err.message).toContain("Invalid signature");
  });

  test("refusals in the plan: unsigned files, snapshots, credentials, no SBOM under supply-chain", async () => {
    const central = fakeCentral();
    const [t] = await createPublishTargets([decl()], deps(central.fetch));
    expect((await refusal(t!.plan(publishContext(member({ unsigned: true }), env)))).code).toBe("publish-maven-unsigned");
    expect((await refusal(t!.plan(publishContext(member({ snapshot: true }), env)))).code).toBe("publish-maven-snapshot");
    expect((await refusal(t!.plan(publishContext(member(), {})))).code).toBe("publish-credentials-missing");
    expect((await refusal(t!.plan(publishContext(member(), env, [], { requireSbom: true })))).code).toBe("publish-sbom-missing");
    expect((await t!.plan(publishContext(member({ sbom: true }), env, [], { requireSbom: true })))[0]!.sbom).toBe("kit-1.2.0-cyclonedx.json");
  });

  test("names: the component, and the dependencies it needs at run time", async () => {
    const [t] = await createPublishTargets([decl()], deps(fakeCentral().fetch));
    expect(await t!.names!(publishContext(member(), env))).toEqual({ provides: ["maven:dev.arugula:kit"], needs: ["maven:dev.arugula:core"] });
    expect(t!.setStatus).toBeUndefined();
  });
});
