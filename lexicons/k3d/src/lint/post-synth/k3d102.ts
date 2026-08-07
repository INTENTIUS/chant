/**
 * K3D102: registry proxy credential in the emitted config.
 *
 * The other half of K3D001: the lint rule sees literals in source, this
 * sees what actually landed in the artifact — a value that arrived through
 * a variable, a helper, or anything else the AST rule cannot follow. The
 * emitted config is the file people commit, attach to issues and copy to
 * other machines, which is exactly where a registry credential must not be.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { k3dDocuments } from "./k3d101";

export const k3d102: PostSynthCheck = {
  id: "K3D102",
  description: "The emitted cluster config carries a registry proxy password",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const { source, doc } of k3dDocuments(ctx)) {
      if (typeof doc !== "object" || doc === null) continue;
      const registries = (doc as Record<string, unknown>).registries as Record<string, unknown> | undefined;
      const create = registries?.create as Record<string, unknown> | undefined;
      const proxy = create?.proxy as Record<string, unknown> | undefined;
      const password = proxy?.password;
      if (typeof password === "string" && password.length > 0) {
        diagnostics.push({
          checkId: "K3D102",
          severity: "error",
          message:
            `${source}: registries.create.proxy.password is present in the emitted config — ` +
            `this file is the walk-away artifact and a credential inside it is a credential in source. ` +
            `Connect a pre-existing registry via registries.use, or supply the proxy credential outside chant.`,
          lexicon: "k3d",
        });
      }
    }
    return diagnostics;
  },
};
