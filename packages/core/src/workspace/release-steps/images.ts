/** `release.images` (#4657): the publish job builds the images again, or checks the archives the cut handed on, before its build. */
import { ACTION_PINS, usesRef } from "../../action-pins";
import type { ReleaseWorkflowForge } from "../release-workflow";
import type { ReleaseWorkflowFeature } from "./types";

/** Where `chant release images` writes the digests the publish job's build reads (#4657), by default and at a workstation. */
export const RELEASE_DIGESTS_FILE = ".chant/release-digests.json";

/**
 * Where a generated publish job writes the digests: the runner's temp
 * directory, outside the checkout, so `chant release publish` finds the tree
 * as the cut left it (#4853). A repository that commits files under `.chant/`
 * can't ignore the directory, and a digests file there made the publish
 * refuse with `release-worktree-dirty`.
 */
export const RELEASE_DIGESTS_PATHS: Record<ReleaseWorkflowForge, string> = {
  github: "$RUNNER_TEMP/chant-release-digests.json",
  forgejo: "$RUNNER_TEMP/chant-release-digests.json",
  gitlab: "/tmp/chant-release-digests.json",
};

/** The workflow artifact the cut job hands its image archives on in. */
export const RELEASE_IMAGES_ARTIFACT = "chant-release-images";

/** The directory every path is under, which the artifact actions store the files relative to. */
function commonDir(paths: readonly string[]): string {
  const dirs = paths.map((p) => p.split("/").slice(0, -1));
  const first = dirs[0] ?? [];
  let n = 0;
  while (n < first.length && dirs.every((d) => d[n] === first[n])) n++;
  return first.slice(0, n).join("/") || ".";
}

/**
 * In a dispatched release the cut job hands the archives to the publish job,
 * which checks them against the recorded digests (`release images
 * --no-build`) rather than building them again, so a moved package mirror
 * between the two jobs cannot change what is published. On a tag the publish
 * job builds them again from the release.
 */
export const imagesFeature: ReleaseWorkflowFeature = {
  name: "images",
  steps: (c) => {
    if (!c.images) return [];
    const gitlab = c.forge === "gitlab";
    const handed = c.archives.length > 0;
    if (c.job === "cut") {
      if (!handed) return [];
      if (gitlab) return [{ slot: "artifactPaths", order: 10, items: [{ lines: c.archives.map((a) => `      - ${JSON.stringify(a)}`) }] }];
      const upload = usesRef(c.forge === "forgejo" ? ACTION_PINS.uploadArtifact3 : ACTION_PINS.uploadArtifact4);
      const lines = [`      - uses: ${upload}`, "        with:", `          name: ${RELEASE_IMAGES_ARTIFACT}`, "          path: |", ...c.archives.map((a) => `            ${a}`), "          if-no-files-found: error", "          retention-days: 1"];
      return [{ slot: "afterCut", order: 20, items: [{ lines }] }];
    }
    const digests = RELEASE_DIGESTS_PATHS[c.forge];
    const build = [`${c.chant} release images ${c.label}${handed ? " --no-build" : ""} -o "${digests}"`, gitlab ? `export CHANT_RELEASE_DIGESTS="${digests}"` : `echo "CHANT_RELEASE_DIGESTS=${digests}" >> "$GITHUB_ENV"`];
    const download = usesRef(c.forge === "forgejo" ? ACTION_PINS.downloadArtifact3 : ACTION_PINS.downloadArtifact4);
    return [
      ...(handed && !gitlab ? [{ slot: "prepare" as const, order: 24, items: [{ lines: [`      - uses: ${download}`, "        with:", `          name: ${RELEASE_IMAGES_ARTIFACT}`, `          path: ${commonDir(c.archives)}`] }] }] : []),
      { slot: "beforeBuild", order: 10, items: build },
    ];
  },
};
