/**
 * Table-driven flag parsing for warden CLIs. Same grammar every warden had by
 * hand: `--flag value` pairs and boolean switches, no positionals, unknown
 * flags rejected. Validation failures throw `CliError(2)` — the parser stays
 * pure so it can be unit-tested without a process.
 */

import { CliError } from "./cli-error.js";

export type FlagSpec =
  | { kind: "value"; set: (value: string, flag: string) => void }
  | { kind: "boolean"; set: () => void };

export function parseFlags(argv: string[], specs: Record<string, FlagSpec>): void {
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    if (!flag.startsWith("--")) throw new CliError(2, `unexpected positional argument: ${flag}`);
    const spec = specs[flag];
    if (!spec) throw new CliError(2, `unknown flag: ${flag}`);
    if (spec.kind === "boolean") {
      spec.set();
    } else {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new CliError(2, `${flag} requires a value`);
      spec.set(v, flag);
    }
    i++;
  }
}
