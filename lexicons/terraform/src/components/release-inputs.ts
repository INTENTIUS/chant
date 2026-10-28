/**
 * The files a release records for a `terraform-apply` step (chant#4542).
 *
 * The step names its root by key, so core can't see which files it deploys.
 * `terraformReleaseInputs` answers core's `releaseInputs` with the set a
 * pull request's plan treats as the root's change (`rootWatchPaths`): the
 * root's directory, each local module it reaches, and its var files, plus
 * its backend-config files. A release cut records them for the component,
 * and a promote or rollback under the release writes them under
 * `.chant/release-templates/<digest>/` and sets the step's `dir` to the copy
 * of the root, so `terraform-apply` plans the release's configuration against
 * the environment's state.
 *
 * A root whose state is a file in its own directory (the `local` backend) is
 * unbound: a plan run in a copy elsewhere would read no state and propose
 * creating everything. Such a root rolls back through `chant lifecycle
 * rollback --to`. A live choudoufu root has no state file and is recorded.
 */

import { dirname, relative, resolve } from "node:path";
import type { ReleaseInputs, ReleaseInputsContext, ReleaseInputsUnbound } from "@intentius/chant/components/capability";
import { loadChantConfigUpward } from "@intentius/chant/config";
import { rootWatchPaths } from "../changed-roots";
import type { TerraformConfig } from "../config";
import { liveEstate } from "../compose/hcl";
import { readBackend } from "../state/backend";

/** The parts of the `terraform-apply` input this reads. */
interface StepInput {
  root: string;
  cwd?: string;
  dir?: string;
}

const toPosix = (p: string): string => p.split("\\").join("/") || ".";

/** What a release records for one `terraform-apply` step, relative to the member's directory. Null when the root is not declared. */
export async function terraformReleaseInputs(input: StepInput, ctx: ReleaseInputsContext): Promise<ReleaseInputs | ReleaseInputsUnbound | null> {
  if (typeof input.root !== "string" || input.root === "") return null;
  const start = resolve(ctx.memberDir, input.cwd ?? ".");
  const { config, configPath } = await loadChantConfigUpward(start);
  const projectRoot = configPath ? dirname(configPath) : start;
  const terraform = (config as { terraform?: TerraformConfig }).terraform;
  const root = terraform?.roots?.[input.root];
  if (!root) return null;
  const binary = terraform?.binary;
  const rootDir = resolve(projectRoot, input.dir ?? root.dir);
  const live = binary === "choudoufu" && (root.estate !== undefined || liveEstate(rootDir, binary).live);
  if (!live) {
    const { backend } = readBackend(rootDir, {
      ...(root.backendConfig ? { backendConfig: root.backendConfig } : {}),
      ...(root.backendConfigFiles ? { backendConfigFiles: root.backendConfigFiles } : {}),
      ...(binary ? { binary } : {}),
    });
    if (backend.type === "local") {
      return {
        unbound:
          `root "${input.root}" keeps its state in a local file under ${toPosix(relative(ctx.memberDir, rootDir))}, ` +
          "so a plan of a recorded copy would read no state; roll it back with chant lifecycle rollback --to <ref>",
      };
    }
  }
  const fromMember = (abs: string): string => toPosix(relative(ctx.memberDir, abs));
  const paths = rootWatchPaths(projectRoot, { dir: relative(projectRoot, rootDir) || ".", ...(root.varFiles ? { varFiles: root.varFiles } : {}) }, binary).map((p) =>
    fromMember(resolve(projectRoot, p)),
  );
  for (const file of root.backendConfigFiles ?? []) paths.push(fromMember(resolve(rootDir, file)));
  return { field: "dir", dir: fromMember(rootDir), paths: [...new Set(paths)].sort() };
}
