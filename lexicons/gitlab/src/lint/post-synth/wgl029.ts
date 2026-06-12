/**
 * WGL029: Unpinned include:project / component Reference
 *
 * Flags an `include:project` or CI/CD `component:` resolved by a moving ref — a
 * branch, no `ref:` at all (defaults to the project's default branch), or a
 * floating component version — instead of a pinned tag or commit SHA. A
 * repointed ref turns the included configuration into a supply-chain entry point.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractIncludes, isPinnedRef } from "./yaml-helpers";

export const wgl029: PostSynthCheck = {
  id: "WGL029",
  description: "include:project / component resolved by a moving ref instead of a pinned tag or SHA",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const entry of extractIncludes(yaml)) {
        if (entry.kind === "project") {
          if (!entry.ref) {
            diagnostics.push({
              checkId: "WGL029",
              severity: "warning",
              message: `include:project "${entry.value}" has no ref: and resolves to the project's default branch (a moving target). Pin it to a tag or commit SHA.`,
              entity: entry.value,
              lexicon: "gitlab",
            });
          } else if (!isPinnedRef(entry.ref)) {
            diagnostics.push({
              checkId: "WGL029",
              severity: "warning",
              message: `include:project "${entry.value}" is pinned to the moving ref "${entry.ref}". Pin it to a tag or commit SHA.`,
              entity: entry.value,
              lexicon: "gitlab",
            });
          }
        } else if (entry.kind === "component") {
          const at = entry.value.lastIndexOf("@");
          const version = at === -1 ? "" : entry.value.slice(at + 1);
          if (!version || !isPinnedRef(version)) {
            diagnostics.push({
              checkId: "WGL029",
              severity: "warning",
              message: `component "${entry.value}" uses ${version ? `the moving version "${version}"` : "no pinned version"}. Pin it to a released version tag or commit SHA.`,
              entity: entry.value,
              lexicon: "gitlab",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
