/**
 * #4031: who may cut a release, and the cut's signature. The declaration's
 * `identity.gates.release` names the class that may cut; a cut is signed
 * with the actor's ssh key over the release digest, label, actor and time,
 * and `release list` and `workspace status` verify it on every read. With
 * `ci.green.signedSince`, a hand-pushed green tag cuts nothing.
 */

import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import { cutRelease, ReleaseCutError } from "./release-cut";
import { readCuts, type ReleaseArtifact } from "./release-store";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { hasSshKeygen, TestRepo, type Key } from "../workspace/trust/test-repo";
import { releasesDocument } from "../workspace/releases";
import { workspaceStatus, type StatusDocument } from "../workspace/status";
import { checkReleaseSignature, type GateAdmissionRule } from "../workspace/identity-gate-rule";
import { contract } from "../workspace/__fixtures__/contract-repo";
import releasesSchema from "../workspace/releases.schema.json";
import statusSchema from "../workspace/status.schema.json";
import { rmSync } from "node:fs";
import { dirname } from "node:path";

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

function compiler(): TargetCompiler {
  return {
    async compile(env): Promise<CompiledTarget> {
      return {
        env,
        params: [],
        components: ["api"],
        buildSteps: { api: [{ kind: "docker-build", context: "api", into: "api.tar" }] },
        buildInputs: { api: ["api"] },
        componentFiles: { api: "api.component.ts" },
        templates: [{ component: "api", path: "dist/api.json", content: `{"env":"${env}"}\n` }],
      };
    },
    async buildArtifacts(_env, components): Promise<ReleaseArtifact[]> {
      return components.map((c) => ({ component: c, kind: "image" as const, path: `${c}.tar`, digest: `sha256:${"b".repeat(64)}` }));
    },
  };
}

/** A domain class, `releaser`, from a path pin, granted by the `releaser` role. */
const PLUGIN = {
  "classes/package.json": JSON.stringify({ name: "@acme/classes", version: "1.0.0", exports: { "./workspace-principals": "./principals.json" } }),
  "classes/principals.json": JSON.stringify({ schema: 1, classes: [{ name: "releaser", description: "people who may cut a release", role: "releaser" }] }),
};

/**
 * A workspace whose root member is a chant project with three environments,
 * signed by alice and bob, with alice holding the releaser role. `extra`
 * goes into the declaration.
 */
function setup(extra: Record<string, unknown>): { r: TestRepo; alice: Key; bob: Key; head: string } {
  const r = new TestRepo("release-cut");
  repos.push(r);
  const alice = r.key("alice");
  const bob = r.key("bob");
  r.write("chant.workspace.json", JSON.stringify({ name: "acme", schema: 1, pins: [{ path: "classes" }], members: [{ name: "root", dir: ".", kind: "other", because: "the release fixture" }], ...extra }, null, 2));
  for (const [path, text] of Object.entries(PLUGIN)) r.write(path, text);
  r.write(".chant/allowed_signers", `alice ${alice.pub}\nbob ${bob.pub}\n`);
  r.write(".chant/trust.json", JSON.stringify({ schema: 1, roles: { releaser: ["alice"] } }));
  r.write("chant.config.ts", `export default { environments: ["dev", "prod"] };\n`);
  r.write("api.component.ts", "export const api = {};\n");
  r.write("api/Dockerfile", "FROM scratch\n");
  const head = r.commit("init");
  return { r, alice, bob, head };
}

const NOW = () => new Date("2026-10-16T10:00:00.000Z");
const cut = (r: TestRepo, actor: string, sign?: Key, label: string | null = "v1.0.0") =>
  cutRelease({ cwd: r.dir, compiler: compiler(), label, actor, env: {}, now: NOW, ...(sign ? { sign: sign.file } : {}) });
const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as ReleaseCutError).code;
const noLedger = (r: TestRepo) => spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/chant/lifecycle"], { cwd: r.dir }).status !== 0;

describe.skipIf(!hasSshKeygen)("who may cut a release (#4031)", () => {
  const RELEASE_GATE = { identity: { gates: { release: { class: "releaser" } } } };

  test("cutting as someone outside the release gate's class is refused, and nothing is written", async () => {
    const { r, bob } = setup(RELEASE_GATE);
    r.git(["tag", `ci/green/${r.git(["rev-parse", "HEAD"]).trim()}`]);
    const err = await cut(r, "bob", bob).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseCutError);
    expect((err as ReleaseCutError).code).toBe("release-signer-refused");
    expect((err as ReleaseCutError).message).toMatch(/bob is not in the class releaser that gate release needs/);
    expect(noLedger(r)).toBe(true);
  });

  test("an unsigned cut, or one signed with another signer's key, is refused under the gate", async () => {
    const { r, alice, bob } = setup(RELEASE_GATE);
    r.git(["tag", `ci/green/${r.git(["rev-parse", "HEAD"]).trim()}`]);
    expect(await code(cut(r, "alice"))).toBe("release-unsigned");
    const forged = await cut(r, "alice", bob).catch((e: unknown) => e);
    expect((forged as ReleaseCutError).code).toBe("release-signer-refused");
    expect((forged as ReleaseCutError).message).toMatch(/does not verify for alice/);
    expect(noLedger(r)).toBe(true);
    expect(alice.name).toBe("alice");
  });

  test("a cut by a releaser carries a signature that release list and workspace status verify", async () => {
    const { r, alice } = setup(RELEASE_GATE);
    const head = r.git(["rev-parse", "HEAD"]).trim();
    r.git(["tag", `ci/green/${head}`]);
    const result = await cut(r, "alice", alice);
    expect(result.cut?.signature).toMatch(/^-----BEGIN SSH SIGNATURE-----/);
    const { cuts } = await readCuts({ cwd: r.dir });
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ label: "v1.0.0", actor: "alice", signature: result.cut!.signature });

    const list = await releasesDocument({ cwd: r.dir });
    contract(releasesSchema).expectValid(list);
    const entry = (list as Extract<typeof list, { releases: unknown }>).releases[0];
    expect(entry.cuts[0].signatureCheck).toMatchObject({ status: "verified", key: expect.stringMatching(/^SHA256:/), reason: "signed by alice, in the class releaser" });

    const status = (await workspaceStatus({ cwd: r.dir, env: "dev" })) as Extract<StatusDocument, { members: unknown }>;
    contract(statusSchema).expectValid(status);
    expect(status.members[0].releaseCuts).toEqual([
      {
        releaseDigest: result.release.releaseDigest,
        label: "v1.0.0",
        commit: head,
        actor: "alice",
        timestamp: "2026-10-16T10:00:00.000Z",
        signature: result.cut!.signature,
        signatureCheck: { status: "verified", key: entry.cuts[0].signatureCheck.key, reason: "signed by alice, in the class releaser" },
      },
    ]);

    // A cut line edited after the fact no longer verifies: the label is signed.
    const rule: GateAdmissionRule = { gate: "release", class: null, signers: { signersPath: ".chant/allowed_signers", active: true, signers: [{ principal: "alice", key: alice.pub, line: 1 }] }, roles: {}, classes: [] };
    expect(checkReleaseSignature(rule, { ...cuts[0] }).status).toBe("verified");
    expect(checkReleaseSignature(rule, { ...cuts[0], label: "v9.9.9" })).toMatchObject({ status: "unverified", reason: expect.stringMatching(/does not verify for alice/) });
    expect(checkReleaseSignature(rule, { ...cuts[0], signature: null }).status).toBe("unsigned");
  });

  test("without a release gate a cut may be unsigned, and a signed one is still verified on read", async () => {
    const { r, bob } = setup({});
    r.git(["tag", `ci/green/${r.git(["rev-parse", "HEAD"]).trim()}`]);
    const plain = await cut(r, "carol", undefined, "v1");
    expect(plain.cut?.signature).toBeNull();
    r.write("README.md", "next\n");
    const next = r.commit("next");
    r.git(["tag", `ci/green/${next}`]);
    const signed = await cut(r, "bob", bob, "v2");
    expect(signed.cut?.signature).toMatch(/BEGIN SSH SIGNATURE/);
    const list = (await releasesDocument({ cwd: r.dir })) as Extract<Awaited<ReturnType<typeof releasesDocument>>, { releases: unknown }>;
    // Both cuts share one time, so the list's order between them is the digests'.
    expect(list.releases.map((x) => [x.label, x.cuts[0].signatureCheck.status]).sort()).toEqual([
      ["v1", "unsigned"],
      ["v2", "verified"],
    ]);
  });

  test("with ci.green.signedSince, a hand-pushed green tag cuts nothing", async () => {
    const { r, alice } = setup({
      ...RELEASE_GATE,
      ci: { green: { branch: "main", phases: { test: ["test"] }, require: ["test"], signedSince: "2000-01-01T00:00:00Z" } },
    });
    const head = r.git(["rev-parse", "HEAD"]).trim();
    r.git(["tag", "-a", "-m", "ci: by hand", `ci/green/${head}`]);
    const err = await cut(r, "alice", alice).catch((e: unknown) => e);
    expect((err as ReleaseCutError).code).toBe("release-commit-not-green");
    expect((err as ReleaseCutError).message).toMatch(/no ci\/green tag that counts.*ignored: ci\/green\/[0-9a-f]+ \(unsigned\)/);
    expect(noLedger(r)).toBe(true);
  });
});
