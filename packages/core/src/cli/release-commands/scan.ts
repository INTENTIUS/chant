import type { ReleaseCommandDoc } from "./types";

/** `chant release scan`: its entry in `chant --help` and the `release` usage line. */
export const scanCommand: ReleaseCommandDoc = {
  name: "scan",
  helpOrder: 55,
  help: [
    "  release scan <label|digest> | --deployed [<env>] [--json]",
    "                        Scan a published release again against today's",
    "                        vulnerability database: the SBOMs its publish",
    "                        recorded, with the scanner and vulnPolicy the publish",
    "                        uses, appended to the publish record as a rescanned",
    "                        line. --deployed scans every release the latest",
    "                        deploy record of each environment (or of <env>)",
    "                        names. Exits 1 when the policy blocks a finding.",
  ],
  usage: { order: 32, text: "release scan <label|digest> | --deployed [<env>] [--json]" },
};
