import type { ReleaseCommandDoc } from "./types";

/** `chant release verify`: its entry in `chant --help` and the `release` usage line. */
export const verifyCommand: ReleaseCommandDoc = {
  name: "verify",
  helpOrder: 50,
  help: [
    "  release verify <label|digest> [--sigstore [--assets <dir>]] [--json]",
    "                        Check, offline, that the release was signed by a key",
    "                        .chant/allowed_signers lists at the release's commit.",
    "                        --sigstore also checks the Sigstore signatures and",
    "                        SLSA provenance the publish recorded, with cosign:",
    "                        an image's in its registry, a forge release's in the",
    "                        directory --assets names.",
  ],
  usage: { order: 30, text: "release verify <label|digest> [--sigstore [--assets <dir>]] [--json]" },
};
