/**
 * #4049: `chant release verify` checks a release's signature offline against
 * `.chant/allowed_signers` at the release's commit. A release signed by a
 * listed key verifies; an unsigned one and one signed by a key the file does
 * not list do not; and a key listed only after the release's commit does not
 * make it verify. Throwaway keys in temp repos only.
 */

import { afterAll, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { cutRelease } from "./release-cut";
import { verificationCode, verifyRelease, type ReleaseVerification } from "./release-verify";
import type { ReleaseArtifact } from "./release-store";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { hasSshKeygen, TestRepo, type Key } from "../workspace/trust/test-repo";

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

const compiler: TargetCompiler = {
  async compile(env): Promise<CompiledTarget> {
    return { env, params: [], components: ["api"], buildSteps: {}, buildInputs: {}, componentFiles: { api: "api.component.ts" }, templates: [{ component: "api", path: "dist/api.json", content: `{"env":"${env}"}\n` }] };
  },
  async buildArtifacts(): Promise<ReleaseArtifact[]> {
    return [];
  },
};

/** A plain project whose signers file lists alice, with one green commit. */
function setup(): { r: TestRepo; alice: Key; bob: Key } {
  const r = new TestRepo("release-verify");
  repos.push(r);
  const alice = r.key("alice");
  const bob = r.key("bob");
  r.write(".chant/allowed_signers", `alice ${alice.pub}\n`);
  r.write("chant.config.ts", `export default { environments: ["dev"] };\n`);
  r.write("api.component.ts", "export const api = {};\n");
  green(r, "init");
  return { r, alice, bob };
}

function green(r: TestRepo, message: string): string {
  const head = r.commit(message);
  r.git(["tag", `ci/green/${head}`]);
  return head;
}

const cut = (r: TestRepo, label: string, actor: string, sign?: Key) =>
  cutRelease({ cwd: r.dir, compiler, label, actor, env: {}, now: () => new Date("2026-10-17T10:00:00.000Z"), ...(sign ? { sign: sign.file } : {}) });
const checked = async (r: TestRepo, ref: string): Promise<ReleaseVerification> => {
  const v = await verifyRelease({ cwd: r.dir, ref });
  if ("error" in v) throw new Error(v.error.message);
  return v;
};

describe("chant release verify", () => {
  test.skipIf(!hasSshKeygen)("passes for a release signed by a key the signers file lists at its commit", async () => {
    const { r, alice } = setup();
    const { release } = await cut(r, "v1", "alice", alice);
    const v = await checked(r, "v1");
    expect(v).toMatchObject({ releaseDigest: release.releaseDigest, label: "v1", commit: release.commit, digestMatches: true, status: "verified", verifiedBy: { actor: "alice", key: expect.stringMatching(/^SHA256:/) } });
    expect(v.signers).toEqual({ path: ".chant/allowed_signers", at: release.commit, active: true });
    expect(v.reason).toBe(`signed by alice, checked against .chant/allowed_signers at ${release.commit.slice(0, 12)}`);
    expect(verificationCode(v)).toBeNull();
    // By digest too.
    expect((await checked(r, release.releaseDigest)).status).toBe("verified");
  });

  test("fails for an unsigned release", async () => {
    const { r } = setup();
    await cut(r, "v1", "alice");
    const v = await checked(r, "v1");
    expect(v.status).toBe("unsigned");
    expect(v.verifiedBy).toBeNull();
    expect(v.cuts).toEqual([expect.objectContaining({ actor: "alice", signatureCheck: { status: "unsigned", key: null, reason: "the cut carries no signature" } })]);
    expect(verificationCode(v)).toBe("release-unsigned");
  });

  test.skipIf(!hasSshKeygen)("fails for a release signed by a key the signers file does not list, also once a later commit lists it", async () => {
    const { r, bob } = setup();
    await cut(r, "v1", "bob", bob);
    const v = await checked(r, "v1");
    expect(v.status).toBe("unverified");
    expect(v.reason).toBe(`bob has no key in .chant/allowed_signers at ${v.commit.slice(0, 12)}, so the cut's signature can't count`);
    expect(verificationCode(v)).toBe("release-signature-unverified");

    // bob's key is listed after the release's commit: the release still reads the file at its own commit.
    r.write(".chant/allowed_signers", `alice ${r.key("alice2").pub}\nbob ${bob.pub}\n`);
    green(r, "list bob");
    expect((await checked(r, "v1")).status).toBe("unverified");
  });

  test.skipIf(!hasSshKeygen)("fails for a cut signed with one key in another signer's name", async () => {
    const { r, bob } = setup();
    // bob's key, in alice's name.
    await cut(r, "v1", "alice", bob);
    const v = await checked(r, "v1");
    expect(v.status).toBe("unverified");
    expect(v.reason).toMatch(/the cut's signature does not verify for alice/);
  });

  test("names a release it can't find", async () => {
    const { r } = setup();
    const v = await verifyRelease({ cwd: r.dir, ref: "v9" });
    expect("error" in v && v.error.code).toBe("release-not-found");
  });
});
