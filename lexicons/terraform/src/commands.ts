/**
 * `chant terraform pin-rollout`: one run of a pin-bump rollout (#3189), from
 * the command line. The `TerraformPinRolloutOp` composite runs the same code
 * as an Op step.
 *
 *     chant terraform pin-rollout --module <source> --from <pin> --to <pin>
 *       [--root <dir>]... [--depends-on <dir>=<dir>]... [--ts-source <dir>=<file>]...
 *       [--canary <dir>]... [--waves-from <live-waves.json> [--waves-prefix <dir>]]
 *       [--pull-request] [--base <branch>] [--remote <name>] [--applied-check <name>] [--json]
 *
 * Without `--pull-request` it reports the next wave and opens nothing. Exit
 * 0 when the rollout is complete or a wave's PR was opened (or would be), 3
 * when it is waiting on a merge or an apply (a gate is a fact, #2119), and 1
 * when it stopped on a failed root or a closed PR.
 */

import type { CommandGroup, CommandGroupContext } from "@intentius/chant/cli/command-group";
import { splitJoinedFlags, unknownFlagError } from "@intentius/chant/cli/command-group";
import type { TerraformPinRolloutArgs } from "./op/activities/pin-rollout";
import type { PinRoot } from "./pin";

const USAGE =
  "usage: chant terraform pin-rollout --module <source> --from <pin> --to <pin> [--root <dir>]... [--depends-on <dir>=<dir>]... " +
  "[--ts-source <dir>=<file>]... [--canary <dir>]... [--waves-from <file> [--waves-prefix <dir>]] [--pull-request] " +
  "[--base <branch>] [--remote <name>] [--applied-check <name>] [--json]";

const VALUE_FLAGS = new Set(["--module", "--from", "--to", "--root", "--depends-on", "--ts-source", "--canary", "--waves-from", "--waves-prefix", "--base", "--remote", "--applied-check"]);
const BOOLEAN_FLAGS = new Set(["--pull-request", "--json"]);

/** Parse the verb's flags into the activity's args. Throws on an unknown flag or a missing value. */
export function parsePinRolloutArgs(rawArgs: string[]): { args: TerraformPinRolloutArgs; json: boolean } {
  const tokens = splitJoinedFlags(rawArgs, BOOLEAN_FLAGS);
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (BOOLEAN_FLAGS.has(t)) {
      flags.add(t);
      continue;
    }
    if (!VALUE_FLAGS.has(t)) throw t.startsWith("-") ? unknownFlagError(t, USAGE) : new Error(`unexpected argument "${t}"\n${USAGE}`);
    const v = tokens[++i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${t} needs a value\n${USAGE}`);
    values.set(t, [...(values.get(t) ?? []), v]);
  }
  const one = (flag: string): string | undefined => values.get(flag)?.at(-1);
  const pairs = (flag: string): Array<[string, string]> =>
    (values.get(flag) ?? []).map((v) => {
      const eq = v.indexOf("=");
      if (eq <= 0 || eq === v.length - 1) throw new Error(`${flag} takes <dir>=<value>, got "${v}"`);
      return [v.slice(0, eq), v.slice(eq + 1)];
    });
  for (const required of ["--module", "--from", "--to"]) if (!one(required)) throw new Error(`${required} is required\n${USAGE}`);

  const dependsOn = pairs("--depends-on");
  const tsSource = new Map(pairs("--ts-source"));
  const named = [...new Set([...(values.get("--root") ?? []), ...dependsOn.map(([r]) => r), ...tsSource.keys()])];
  const roots: PinRoot[] | undefined =
    named.length > 0
      ? named.map((root) => {
          const deps = dependsOn.filter(([r]) => r === root).map(([, d]) => d);
          return { root, ...(deps.length > 0 ? { dependsOn: deps } : {}), ...(tsSource.has(root) ? { tsSource: tsSource.get(root)! } : {}) };
        })
      : undefined;

  const args: TerraformPinRolloutArgs = {
    module: one("--module")!,
    from: one("--from")!,
    to: one("--to")!,
    mode: flags.has("--pull-request") ? "pull-request" : "report",
    ...(roots ? { roots } : {}),
    ...(values.has("--canary") ? { canaries: values.get("--canary")! } : {}),
    ...(one("--waves-from") ? { wavesFrom: one("--waves-from")! } : {}),
    ...(one("--waves-prefix") ? { wavesPrefix: one("--waves-prefix")! } : {}),
    ...(one("--base") ? { base: one("--base")! } : {}),
    ...(one("--remote") ? { remote: one("--remote")! } : {}),
    ...(one("--applied-check") ? { appliedCheck: one("--applied-check")! } : {}),
  };
  return { args, json: flags.has("--json") };
}

/** Exit status for a rollout's status. */
export function pinRolloutExitCode(status: string): number {
  if (status === "waiting") return 3;
  if (status === "stopped") return 1;
  return 0;
}

async function runPinRolloutVerb(ctx: CommandGroupContext): Promise<number> {
  let parsed: ReturnType<typeof parsePinRolloutArgs>;
  try {
    parsed = parsePinRolloutArgs(ctx.rawArgs);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const { readPinRollout } = await import("./op/activities/pin-rollout");
  try {
    const result = await readPinRollout(parsed.args);
    console.log(parsed.json ? JSON.stringify(result, null, 2) : result.summary);
    return pinRolloutExitCode(result.status);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export const terraformCommands: CommandGroup = {
  name: "terraform",
  description: "Terraform and OpenTofu roots: roll a module version out as one pin-bump PR per wave",
  commands: [{ name: "pin-rollout", description: "Read a pin-bump rollout's state and open the next wave's PR when it is due", handler: runPinRolloutVerb }],
};
