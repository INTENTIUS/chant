/** A `ci serve` host renders its release jobs for its own platform: its native image platform needs no QEMU, and another gets binfmt as a `run` step, since the host runs no actions. */
import { describe, expect, test } from "vitest";
import { hostDispatchJobs, hostImagePlatform, hostReleaseJob, hostStepAction, type HostJob } from "./ci-serve-release";
import { RELEASE_BINFMT_IMAGE, qemuArchitectures, qemuSetup } from "./release-steps/qemu";
import type { ReleaseWorkflowInput } from "./release-workflow";
import type { SecurityGroup } from "./security";

const input = (platforms: string[]): ReleaseWorkflowInput => ({
  forge: "github",
  groups: new Set<SecurityGroup>(),
  images: true,
  imageArchives: ["build/api.tar"],
  imagePlatforms: platforms,
  publish: [{ type: "oci", repository: "r.example/acme/api" }],
  pipeline: { trigger: "dispatch", gate: "head" },
});

const binfmt = (job: HostJob): string[] => job.steps.filter((s) => s.run?.includes(RELEASE_BINFMT_IMAGE)).map((s) => s.run!);

describe("a host releases images for its own platform (#5536)", () => {
  test("hostImagePlatform names the linux platform of the host's architecture", () => {
    expect(hostImagePlatform("arm64")).toBe("linux/arm64");
    expect(hostImagePlatform("x64")).toBe("linux/amd64");
  });

  test("qemuArchitectures leaves out the runner's platform, whichever it is", () => {
    expect(qemuArchitectures(["linux/amd64", "linux/arm64"])).toEqual(["arm64"]);
    expect(qemuArchitectures(["linux/amd64", "linux/arm64"], "linux/arm64")).toEqual(["amd64"]);
    expect(qemuArchitectures(["linux/arm64"], "linux/arm64")).toEqual([]);
  });

  test("on an arm64 host, linux/arm64 alone adds no QEMU step, and the job runs no action it can't stand in for", () => {
    for (const job of [hostReleaseJob({ input: input(["linux/arm64"]) }, {}, "linux/arm64"), ...Object.values(hostDispatchJobs({ input: input(["linux/arm64"]) }, {}, "linux/arm64"))]) {
      expect(binfmt(job)).toEqual([]);
      expect(job.steps.some((s) => s.uses?.startsWith("docker/setup-qemu-action@"))).toBe(false);
      for (const s of job.steps) expect(() => hostStepAction(s)).not.toThrow();
    }
  });

  test("a platform the host does not run natively gets binfmt as a run step, never the QEMU action", () => {
    const { cut } = hostDispatchJobs({ input: input(["linux/arm64", "linux/amd64"]) }, {}, "linux/arm64");
    expect(binfmt(cut)).toHaveLength(1);
    expect(binfmt(cut)[0]).toContain("--install amd64");
    expect(cut.steps.some((s) => s.uses?.startsWith("docker/setup-qemu-action@"))).toBe(false);
    const publish = hostReleaseJob({ input: input(["linux/amd64"]) }, {}, "linux/arm64");
    expect(binfmt(publish)[0]).toContain("--install amd64");
  });

  test("on an amd64 host the render is what it was", () => {
    expect(binfmt(hostReleaseJob({ input: input(["linux/amd64"]) }, {}, "linux/amd64"))).toEqual([]);
    expect(binfmt(hostReleaseJob({ input: input(["linux/arm64"]) }, {}, "linux/amd64"))[0]).toContain("--install arm64");
  });

  test("qemuSetup keeps the action on GitHub and Forgejo unless asked for the run line", () => {
    expect(qemuSetup("github", ["linux/arm64"], {})).toEqual([expect.objectContaining({ uses: expect.stringContaining("docker/setup-qemu-action@") })]);
    expect(qemuSetup("github", ["linux/arm64"], {}, { via: "run" })).toEqual([{ run: expect.stringContaining(`${RELEASE_BINFMT_IMAGE}`) }]);
    expect(qemuSetup("github", ["linux/arm64"], {}, { runnerPlatform: "linux/arm64" })).toEqual([]);
  });
});
