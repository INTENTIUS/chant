/** PyPI trusted publishing on GitLab: the ID token the `pypi` target reads. */
import type { ReleaseWorkflowTarget } from "../release-workflow";
import type { ReleaseWorkflowFeature } from "./types";

/**
 * The audience of the `PYPI_ID_TOKEN` a GitLab publish job needs, or null
 * when no `pypi` target uses trusted publishing: `pypi`, or `testpypi` for
 * a target on TestPyPI. A target that sets `auth: "token"`, or another index
 * with its own URLs, takes a token only. With `auth` unset the target uses
 * trusted publishing when its token's variable is not set, which the
 * generator can't see, so the job gets the token; declaring it costs nothing.
 * The first such target names the audience.
 */
export function pypiIdTokenAudience(targets: ReadonlyArray<ReleaseWorkflowTarget>): "pypi" | "testpypi" | null {
  const t = targets.find((x) => x.type === "pypi" && x.auth !== "token" && x.uploadUrl === undefined);
  return t ? (t.index === "testpypi" ? "testpypi" : "pypi") : null;
}

/** `PYPI_ID_TOKEN` in the GitLab publish job's `id_tokens`, beside `SIGSTORE_ID_TOKEN`. GitHub and Forgejo ask for the token at run time from `id-token: write`, which the job already has. */
export const pypiFeature: ReleaseWorkflowFeature = {
  name: "pypi",
  steps: (c) => {
    const aud = c.forge === "gitlab" && c.job === "publish" ? pypiIdTokenAudience(c.input.publish ?? []) : null;
    return aud ? [{ slot: "idTokens", order: 10, items: [{ lines: ["    PYPI_ID_TOKEN:", `      aud: ${aud}`] }] }] : [];
  },
};
