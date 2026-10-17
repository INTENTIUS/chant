/**
 * `chant run --components --release <label|digest>` (#4043): the run builds
 * from the checked-out commit, so the release must be cut from it and have a
 * target for the environment. Checked before anything deploys.
 */
import { describe, test, expect, vi } from "vitest";
import { makeRelease } from "../../lifecycle/release-store";

const COMMIT = "a1b2c3d4".repeat(5);
const release = makeRelease({
  member: null,
  commit: COMMIT,
  artifactDigests: [],
  targets: [{ env: "dev", templates: [], params: [] }],
});
let head = COMMIT;

vi.mock("../../lifecycle/git", () => ({
  getHeadCommit: async () => head,
  fetchLifecycle: async () => true,
  pushLifecycle: async () => false,
}));
vi.mock("../../lifecycle/release-store", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/release-store")>("../../lifecycle/release-store");
  return {
    ...actual,
    resolveRelease: async (ref: string) => (ref === "v1" || ref === release.releaseDigest ? { release, label: "v1" } : null),
  };
});

const { resolveRunRelease } = await import("./run");

describe("resolveRunRelease", () => {
  test("a release cut from HEAD with a target for the environment is the run's release, by label or digest", async () => {
    head = COMMIT;
    expect(await resolveRunRelease("v1", "dev", ".")).toMatchObject({ releaseDigest: release.releaseDigest, label: "v1" });
    expect(await resolveRunRelease(release.releaseDigest, "dev", ".")).toMatchObject({ releaseDigest: release.releaseDigest });
  });

  test("a release it can't find is refused", async () => {
    expect(await resolveRunRelease("v9", "dev", ".")).toMatch(/no release is labelled or digested "v9"/);
  });

  test("a release cut from another commit is refused, and the message says why", async () => {
    head = "f".repeat(40);
    const why = await resolveRunRelease("v1", "dev", ".");
    expect(why).toMatch(/was cut from a1b2c3d4a1b2 and this checkout is at ffffffffffff/);
    expect(why).toMatch(/promote --release/);
  });

  test("a release with no target for the environment is refused", async () => {
    head = COMMIT;
    expect(await resolveRunRelease("v1", "prod", ".")).toMatch(/has no target for "prod"/);
  });
});
