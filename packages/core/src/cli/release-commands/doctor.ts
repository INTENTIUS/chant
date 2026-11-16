import type { ReleaseCommandDoc } from "./types";

/** `chant release doctor`: its entry in `chant --help` and the `release` usage line. */
export const doctorCommand: ReleaseCommandDoc = {
  name: "doctor",
  helpOrder: 70,
  help: [
    "  release doctor [--json]",
    "                        Before a cut, ask each release.publish target whether",
    "                        a publish from here can succeed: credentials, OIDC,",
    "                        npm trusted publishers and dist-tags, registry and",
    "                        forge access. Says what it can't observe from here.",
    "                        Exits 1 when a check fails.",
  ],
  usage: { order: 40, text: "release doctor [--json]" },
};
