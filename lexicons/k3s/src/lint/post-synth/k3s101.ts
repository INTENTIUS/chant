/**
 * K3S101: a literal join token reached the build.
 *
 * The typed surface omits `token` / `agent-token` (#1601) and K3S001
 * catches the literal at source. This is the backstop for the path both
 * miss: a raw prop object built at runtime, spread in, or emitted by a
 * composite. If the key is present with a non-empty string value in the
 * entity the build serialized, the emitted config.yaml carries the
 * cluster's join secret, and the build fails.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { configEntities } from "./k3s-helpers";

/**
 * `token`/`agent-token`/`cluster-secret` are the join secret. The etcd S3
 * pair are snapshot-store credentials the flag surface types as plain
 * strings — k3s's own docs point at `etcd-s3-config-secret` (a Secret on
 * the cluster) for exactly this reason.
 */
const SECRET_KEYS = [
  "token",
  "agent-token",
  "cluster-secret",
  "etcd-s3-secret-key",
  "etcd-s3-session-token",
];

export const k3s101: PostSynthCheck = {
  id: "K3S101",
  description: "A k3s config entity carries a literal join token",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const entity of configEntities(ctx)) {
      for (const key of SECRET_KEYS) {
        const value = entity.props[key];
        if (typeof value === "string" && value.length > 0) {
          diagnostics.push({
            checkId: "K3S101",
            severity: "error",
            message:
              `"${entity.name}" carries a literal \`${key}\` — the emitted config.yaml would ` +
              "contain the secret. Use the file/Secret reference form instead " +
              "(`token-file`, `etcd-s3-config-secret`).",
            entity: entity.name,
            lexicon: "k3s",
          });
        }
      }
    }
    return diagnostics;
  },
};
