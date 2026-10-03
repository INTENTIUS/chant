/**
 * OTEL122: zpages or pprof listens on a non-loopback address
 *
 * zpages serves span samples and pipeline internals, and pprof serves profiles, with no authentication. A started one bound to anything but loopback (`0.0.0.0`, a pod IP, an `${env:...}` host) is reachable by whoever reaches that address. `health_check` is not reported: it serves only a status, and a kubelet probe needs it on the pod IP.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel122: PostSynthCheck = {
  id: "OTEL122",
  description: "zpages or pprof listens on a non-loopback address",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL122");
  },
};
