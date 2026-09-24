/**
 * OTEL107: A component's config breaks its definition's rules
 *
 * Each component definition, built-in or custom, can check its own config beyond what the TypeScript type says: memory_limiter needs a limit, filelog needs an include, and so on. A custom component supplies its checks through defineComponent's validate.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { entityDiagnostics } from "./otel-helpers";

export const otel107: PostSynthCheck = {
  id: "OTEL107",
  description: "A component's config breaks its definition's rules",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return entityDiagnostics(ctx, "OTEL107");
  },
};
