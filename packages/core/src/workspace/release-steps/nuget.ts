/** nuget.org trusted publishing on GitLab (#5232): the ID token the `nuget` target reads. */
import type { ReleaseWorkflowTarget } from "../release-workflow";
import type { ReleaseWorkflowFeature } from "./types";

/** The audience nuget.org takes an OIDC ID token for. */
export const NUGET_ID_TOKEN_AUDIENCE = "https://www.nuget.org";

/**
 * True when a `nuget` target may use trusted publishing: it does not set
 * `auth: "token"` and pushes to nuget.org. With `auth` unset the target uses
 * trusted publishing when its key's variable is not set, which the generator
 * can't see, so the job gets the token; declaring it costs nothing.
 */
export function nugetIdTokenNeeded(targets: ReadonlyArray<ReleaseWorkflowTarget>): boolean {
  return targets.some((x) => x.type === "nuget" && x.auth !== "token" && x.pushUrl === undefined);
}

/** `NUGET_ID_TOKEN` in the GitLab publish job's `id_tokens`. GitHub asks for the token at run time from `id-token: write`, which the job already has. */
export const nugetFeature: ReleaseWorkflowFeature = {
  name: "nuget",
  steps: (c) => (c.forge === "gitlab" && c.job === "publish" && nugetIdTokenNeeded(c.input.publish ?? []) ? [{ slot: "idTokens", order: 20, items: [{ lines: ["    NUGET_ID_TOKEN:", `      aud: ${NUGET_ID_TOKEN_AUDIENCE}`] }] }] : []),
};
