/**
 * OTEL118: A pipeline processor can remove or replace a resource attribute chant's telemetry attribution stamps
 *
 * A workload built in a workspace, or with `telemetry.attribution: true`, carries `service.name`, `service.version`, `deployment.environment.name`, `vcs.ref.head.revision` and `chant.*` resource attributes. A `resource` processor that deletes, updates, upserts or hashes one, a `transform` statement that sets, deletes or fails to keep one, or a `resourcedetection` processor with `override` on and a detector that writes one undoes that. The `transform` case matches OTTL text. The check runs only when the build stamps the attribution, so a level-0 project sees nothing.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel118: PostSynthCheck = {
  id: "OTEL118",
  description: "A pipeline processor can remove or replace a resource attribute chant's telemetry attribution stamps",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL118");
  },
};
