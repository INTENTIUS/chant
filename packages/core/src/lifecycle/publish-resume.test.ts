/**
 * #4048: a publish stages every target before it reveals any, records each
 * step in `_releases/publishes.jsonl`, and run again after a failure resumes
 * from that record without publishing anything again. The targets are npm
 * (a fake `npm` with a registry in a file), OCI (a registry fake on
 * 127.0.0.1) and GitHub release assets (a forge fake), and the record is on
 * the `chant/lifecycle` branch of a temp repository.
 */

import { afterAll, describe, expect, test } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { cutRelease } from "./release-cut";
import { createRedactor } from "./publish-credentials";
import { PublishDeclarationSchema } from "./publish-declaration";
import { parsePublishRecords, PUBLISHES_FILE } from "./publish-record";
import { createPublishTargets } from "./publish-targets";
import { PublishRunError, runPublish, type PublishContext, type PublishTarget } from "./release-publish";
import type { ReleaseArtifact } from "./release-store";
import { readFakeNpmRegistry, seedFakeNpmRegistry, startFakeForge, startFakeRegistry, writeFakeNpm, writeOciLayout, writePackage } from "./__tests__/publish-fakes";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { TestRepo } from "../workspace/trust/test-repo";

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

const compiler: TargetCompiler = {
  async compile(env): Promise<CompiledTarget> {
    return {
      env,
      params: [],
      components: ["api"],
      buildSteps: {},
      buildInputs: {},
      componentFiles: { api: "api.component.ts" },
      templates: [{ component: "api", path: "dist/api.json", content: `{"env":"${env}"}\n` }],
    };
  },
  async buildArtifacts(): Promise<ReleaseArtifact[]> {
    return [];
  },
};

const API = "https://api.github.test";
const NO_OIDC = { oidc: false, ci: null, reason: "this run is not in CI, and a workstation has no OIDC token" };

async function release(r: TestRepo) {
  r.write("chant.config.ts", `export default { environments: ["dev"] };\n`);
  r.write("api.component.ts", "export const api = {};\n");
  writePackage(join(r.dir, "packages", "core"), "@acme/core", "2.0.0");
  writePackage(join(r.dir, "packages", "cli"), "@acme/cli", "2.0.0");
  writeOciLayout(join(r.dir, "image"));
  r.write("dist/api.tar.gz", "asset bytes");
  const head = r.commit("init");
  r.git(["tag", `ci/green/${head}`]);
  const cut = await cutRelease({ cwd: r.dir, compiler, label: "v2", actor: "alice", env: {}, now: () => new Date("2026-10-17T10:00:00.000Z") });
  return cut.release;
}

describe("a publish that fails resumes", () => {
  test("a stage failure leaves nothing visible; a reveal failure is resumed; neither run again publishes what went out", async () => {
    const r = new TestRepo("publish-resume");
    repos.push(r);
    const rel = await release(r);
    const reg = await startFakeRegistry({ username: "robot", password: "pw-resume-1", token: "tok-resume-1" });
    try {
      const log = join(dirname(r.dir), "npm.log");
      seedFakeNpmRegistry(log, { packages: { "@acme/core": { versions: ["1.0.0"], distTags: { latest: "1.0.0" } }, "@acme/cli": { versions: ["1.0.0"], distTags: { latest: "1.0.0" } } } });
      const npm = writeFakeNpm(join(dirname(r.dir), "bin"), log);
      const forge = startFakeForge("github", API, "acme/api");
      const decls = [
        { type: "npm", packages: ["packages/core", "packages/cli"] },
        { type: "oci", image: "image", repository: `${reg.host}/acme/api` },
        { type: "forge", forge: "github", repo: "acme/api", api: API, assets: ["dist/api.tar.gz"] },
      ].map((d) => PublishDeclarationSchema.parse(d));
      // The OCI target speaks to the registry fake with the global fetch; the forge target to the forge fake.
      const targets = [...(await createPublishTargets(decls.slice(0, 2), { npm })), ...(await createPublishTargets(decls.slice(2), { fetch: forge.fetch }))];

      const lines: string[] = [];
      const ctx = (env: Record<string, string> = {}): PublishContext => {
        const full = { PATH: process.env.PATH, OCI_USERNAME: "robot", OCI_PASSWORD: "pw-resume-1", GITHUB_TOKEN: "ghs_resume", ...env };
        const redactor = createRedactor(full);
        return { release: rel, label: "v2", releaseTag: "release/v2", provenance: NO_OIDC, cwd: r.dir, tag: null, env: full, redactor, log: (l) => lines.push(redactor.redact(l)) };
      };
      const run = (env: Record<string, string> = {}) => runPublish({ cwd: r.dir, release: rel, label: "v2", targets, ctx: ctx(env), say: (l) => lines.push(l) });
      const npmCalls = () => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { args: string[] }).args) : []);
      const visible = () => ({
        npm: Object.fromEntries(Object.entries(readFakeNpmRegistry(log).packages).map(([n, p]) => [n, p.distTags.latest])),
        ociTags: [...reg.manifests.keys()].filter((k) => !k.startsWith("sha256:")),
        forge: forge.visible(),
      });
      const records = () => parsePublishRecords(r.git(["show", `chant/lifecycle:_releases/${PUBLISHES_FILE}`])).records;
      const nothingVisible = { npm: { "@acme/core": "1.0.0", "@acme/cli": "1.0.0" }, ociTags: [], forge: [] };

      // Run 1: the forge's draft can't be made, after npm and OCI staged. Nothing is visible.
      forge.failOnce(`POST ${API}/repos/acme/api/releases`);
      const first = await run().catch((e: unknown) => e);
      expect(first).toBeInstanceOf(PublishRunError);
      expect(first).toMatchObject({ code: "publish-forge-failed", step: "stage", staged: ["npm (2 packages)", `oci ${reg.host}/acme/api`], revealed: [] });
      expect(visible()).toEqual(nothingVisible);
      expect(records().map((x) => [x.kind, x.step])).toEqual([["npm", "staged"], ["oci", "staged"]]);
      expect(readFakeNpmRegistry(log).packages["@acme/core"]!.distTags.next).toBe("2.0.0");

      // Run 2: npm and OCI are not staged again; the forge stages, then npm's reveal fails at cli, after core's latest moved.
      const npmBefore = npmCalls().length;
      const ociBefore = { uploads: reg.uploads, puts: reg.requests.filter((q) => q.method === "PUT").length };
      const second = await run({ FAKE_NPM_FAIL_TAG: "@acme/cli" }).catch((e: unknown) => e);
      expect(second).toMatchObject({ code: "publish-npm-tag-failed", step: "reveal", revealed: [] });
      expect(npmCalls().slice(npmBefore)).toEqual([
        ["dist-tag", "add", "@acme/core@2.0.0", "latest"],
        ["dist-tag", "add", "@acme/cli@2.0.0", "latest"],
      ]);
      expect(reg.uploads).toBe(ociBefore.uploads);
      expect(reg.requests.filter((q) => q.method === "PUT")).toHaveLength(ociBefore.puts);
      expect(forge.releases).toMatchObject([{ draft: true, assets: [{ name: "api.tar.gz" }] }]);
      expect(lines).toContain("  npm (2 packages): staged by an earlier run; not staged again");
      expect(records().map((x) => [x.kind, x.step])).toEqual([["npm", "staged"], ["oci", "staged"], ["forge", "staged"]]);

      // Run 3: nothing is staged or uploaded again; every reveal runs, core's latest first.
      const npm3 = npmCalls().length;
      const forge3 = forge.calls.length;
      const ociUploads = reg.uploads;
      const done = await run();
      expect(npmCalls().slice(npm3).every((a) => a[0] === "dist-tag")).toBe(true);
      expect(npmCalls().slice(npm3).map((a) => a[2])).toEqual(["@acme/core@2.0.0", "@acme/cli@2.0.0"]);
      expect(reg.uploads).toBe(ociUploads);
      expect(forge.calls.slice(forge3).map((c) => c.method)).toEqual(["PATCH"]);
      expect(visible()).toEqual({ npm: { "@acme/core": "2.0.0", "@acme/cli": "2.0.0" }, ociTags: ["v2"], forge: [{ tag: "release/v2", assets: ["api.tar.gz"] }] });
      expect(done.resumed).toEqual([
        { target: "npm (2 packages)", step: "staged" },
        { target: `oci ${reg.host}/acme/api`, step: "staged" },
        { target: "github release assets acme/api", step: "staged" },
      ]);
      expect(records().filter((x) => x.step === "revealed").map((x) => x.kind)).toEqual(["npm", "oci", "forge"]);
      expect(records().find((x) => x.kind === "forge" && x.step === "staged")!.state).toEqual({ releaseId: "100" });

      // Run 4: every target is published, so nothing is sent at all.
      const sent = { npm: npmCalls().length, forge: forge.calls.length, oci: reg.requests.length };
      const again = await run();
      expect({ npm: npmCalls().length, forge: forge.calls.length, oci: reg.requests.length }).toEqual(sent);
      expect(again.published.every((p) => p.items.every((i) => i.present))).toBe(true);

      // No credential reached the record.
      const branch = r.git(["log", "-p", "chant/lifecycle"]);
      for (const secret of ["pw-resume-1", "tok-resume-1", "ghs_resume"]) expect(branch).not.toContain(secret);
    } finally {
      await reg.close();
    }
  });

  test("a target's key names its declaration, so a resume finds it, and holds no credential", async () => {
    const [a, b, c] = await createPublishTargets(
      [
        { type: "npm", packages: ["x"] },
        { type: "npm", packages: ["x"] },
        { type: "npm", packages: ["y"] },
      ].map((d) => PublishDeclarationSchema.parse(d)),
    );
    const keys = [a, b, c].map((t: PublishTarget | undefined) => t!.key);
    expect(keys[0]).toMatch(/^npm:[0-9a-f]{16}$/);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
  });
});
