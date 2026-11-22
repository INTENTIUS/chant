import type { ReleaseCommandDoc } from "./types";

/** `chant release evidence` (#5465): its entry in `chant --help` and the `release` usage line. */
export const evidenceCommand: ReleaseCommandDoc = {
  name: "evidence",
  helpOrder: 52,
  help: [
    "  release evidence <label|digest> | --since <date> [--until <date>] -o <dir>",
    "              [--sign [<key>]] [--referrers] [--sigstore] [--assets <dir>] [--json]",
    "                        Write the records of a release, or of every release",
    "                        and change in a period, byte for byte into <dir> with",
    "                        an index by control id that says what each record",
    "                        shows and does not show, and SHA256SUMS. Reads only",
    "                        this clone unless --referrers or --sigstore asks.",
    "  release evidence --check <dir> [--json]",
    "                        Check an export from the directory alone: digests,",
    "                        cut and approval signatures, and the sums' signature.",
  ],
  usage: { order: 31, text: "release evidence <label|digest> | --since <date> [--until <date>] -o <dir> | --check <dir>" },
};
