/**
 * E2B012: a template has the git and Node a steward needs.
 *
 * The runtime clones the repository with git and runs the project's own chant
 * with Node, and it stops a run at once on a sandbox that lacks either. This
 * check looks for both in the declaration: Node from a `node` image or a
 * step that installs it, git from a full (not `-slim` or `-alpine`) `node` image, which
 * ships it, or a step that installs it. It cannot see inside other images, so
 * it warns rather than fails: a template from an image that already has both
 * can say so with a `run` step such as `git --version && node --version`.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { templateProps, type TemplateProps } from "../../resources";

function imageRepoAndTag(image: string): { repo: string; tag: string } {
  const ref = image.toLowerCase().split("@")[0];
  const segment = ref.slice(ref.lastIndexOf("/") + 1);
  const [repo, tag = ""] = segment.split(":");
  return { repo, tag };
}

/** Which of git and Node the declaration visibly provides. */
export function stewardTools(props: TemplateProps): { git: boolean; node: boolean } {
  const { repo, tag } = imageRepoAndTag(props.fromImage ?? "");
  const steps = (props.run ?? []).join("\n");
  const nodeImage = repo === "node";
  return {
    node: nodeImage || /\b(nodejs|node|nvm|fnm|volta)\b/.test(steps),
    git: (nodeImage && !/slim|alpine/.test(tag)) || /\bgit\b/.test(steps),
  };
}

export const e2b012: PostSynthCheck = {
  id: "E2B012",
  description: "A Template a steward runs on needs git and Node",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const [name, entity] of ctx.entities) {
      const props = templateProps(entity);
      if (!props) continue;
      const tools = stewardTools(props);
      const missing = [tools.git ? undefined : "git", tools.node ? undefined : "Node"].filter((t): t is string => t !== undefined);
      if (missing.length === 0) continue;
      diagnostics.push({
        checkId: "E2B012",
        severity: "warning",
        message:
          `Template "${name}" shows no sign of ${missing.join(" or ")}. A steward needs both; ` +
          `start from a node image or add a run step that installs ${missing.length === 2 ? "them" : "it"}.`,
        entity: name,
        lexicon: "e2b",
      });
    }
    return diagnostics;
  },
};
