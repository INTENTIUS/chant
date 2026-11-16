/** QEMU for the platforms `release.images` builds that the runner can't (#4876). */
import { ACTION_PINS, usesRef } from "../../action-pins";
import { IMAGE_PINS, imageRef } from "../../image-pins";
import type { OpSetupStep } from "../../lexicon";
import type { ReleasePipelineConfig, ReleaseWorkflowForge } from "../release-workflow";
import { RELEASE_RUNNER_PLATFORM, type ReleaseWorkflowFeature } from "./types";

/** The binfmt image a GitLab job installs QEMU's handlers with (#4876): the repository, which a config's own setup line is recognised by. */
export const RELEASE_BINFMT_IMAGE = IMAGE_PINS.binfmt.repository;

/** The architectures among `platforms` the runner can't run, as QEMU names them (`linux/arm/v7` is `arm`), each once. */
export function qemuArchitectures(platforms: readonly string[]): string[] {
  return [...new Set(platforms.filter((p) => p.split("/").slice(0, 2).join("/") !== RELEASE_RUNNER_PLATFORM).map((p) => p.split("/")[1] ?? p))].sort();
}

/**
 * QEMU's binfmt setup for the platforms `release.images` builds that the
 * runner can't, such as `linux/arm64` on an amd64 runner (#4876), so no
 * product names it in `release.workflow.setup`. GitHub and Forgejo get
 * `docker/setup-qemu-action` at its pin; GitLab a `docker run --privileged`
 * of {@link RELEASE_BINFMT_IMAGE} by the digest `IMAGE_PINS.binfmt` records
 * (#4941, ../../image-pins.ts), which `chant release workflow` notes needs
 * an executor that runs privileged containers. A config whose `setup` names
 * the action or the binfmt image already gets nothing more, so its file
 * renders as it did.
 */
export function qemuSetup(forge: ReleaseWorkflowForge, platforms: readonly string[], p: ReleasePipelineConfig): OpSetupStep[] {
  const archs = qemuArchitectures(platforms);
  if (archs.length === 0) return [];
  const named = (p.setup ?? []).some((s) => ("uses" in s ? /^docker\/setup-qemu-action@/.test(s.uses) : s.run.includes(RELEASE_BINFMT_IMAGE)));
  if (named) return [];
  return forge === "gitlab" ? [{ run: `docker run --privileged --rm ${imageRef(IMAGE_PINS.binfmt)} --install ${archs.join(",")}` }] : [{ uses: usesRef(ACTION_PINS.dockerSetupQemu4), with: { platforms: archs.join(",") } }];
}

/** Before the config's own setup, where the products named it. */
export const qemuFeature: ReleaseWorkflowFeature = {
  name: "qemu",
  setup: (c) => (c.images ? { order: 10, steps: qemuSetup(c.forge, c.input.imagePlatforms ?? [], c.pipeline) } : null),
};
