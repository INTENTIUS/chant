import type { ReleaseCommandDoc } from "./types";

/** `chant release publish`: its entry in `chant --help` and the `release` usage line. */
export const publishCommand: ReleaseCommandDoc = {
  name: "publish",
  helpOrder: 40,
  help: [
    "  release publish <label|digest> [--yes] [--allow-unsigned]",
    "                  [--require-provenance] [--json]",
    "                        Publish a cut release to the targets release.publish",
    "                        in chant.config.ts declares (npm, OCI registries,",
    "                        forge release assets), each with the release's",
    "                        provenance and an SBOM when it has a source. A dry",
    "                        run without --yes. Refuses a revoked release, and",
    "                        with a target a checkout that is not the release's",
    "                        commit. Under security verified-releases it refuses",
    "                        one whose signature does not verify against",
    "                        .chant/allowed_signers unless --allow-unsigned; under",
    "                        supply-chain it warns when the run has no OIDC token",
    "                        and refuses a target with no SBOM source.",
    "                        --require-provenance refuses a run with no OIDC.",
  ],
  usage: { order: 20, text: "release publish <label|digest> [--yes] [--allow-unsigned] [--require-provenance] [--json]" },
};
