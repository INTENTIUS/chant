/**
 * A box's declared services (#2880), read for the activities that take
 * `box: true`: `spriteServicesObserve`, `spriteServiceRestart` and
 * `spriteApplyServices`.
 *
 * The list is the `services` of the box block of the workspace member whose
 * directory holds the working directory, read with core's declaration reader
 * (`@intentius/chant/workspace/box-services`), so it is checked the way
 * `chant workspace check` checks it. The module is imported when a step
 * runs, since a core older than the field has no such module.
 */

/** One declared service, as the declaration states it (core's `BoxService`, less its pointer). */
export interface BoxServiceDeclaration {
  name: string;
  /** As written: split into argv and `${VAR}`-expanded by {@link serviceCommandArgv}. */
  cmd: string;
  needs: string[];
  httpPort: number | null;
  duration: string | null;
  health: string | null;
  optional: boolean;
}

/** The box block's services for the member whose directory holds `cwd`, in file order. */
export async function boxServices(cwd = process.cwd()): Promise<BoxServiceDeclaration[]> {
  let mod: typeof import("@intentius/chant/workspace/box-services");
  try {
    mod = await import("@intentius/chant/workspace/box-services");
  } catch (err) {
    const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new Error(`box: true reads the box block through @intentius/chant 0.95.0 or newer, and the chant installed here has no workspace/box-services module (${why})`);
  }
  return mod.readBoxServices(cwd).services.map((s) => ({
    name: s.name,
    cmd: s.cmd,
    needs: [...s.needs],
    httpPort: s.httpPort,
    duration: s.duration,
    health: s.health,
    optional: s.optional,
  }));
}

/**
 * A service's command with each `${VAR}` replaced from `env`. Throws naming
 * the first variable `env` does not set, so no service is defined with an
 * empty path in it. Pure.
 */
export function expandServiceCommand(name: string, cmd: string, env: NodeJS.ProcessEnv = process.env): string {
  return cmd.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, v: string) => {
    const value = env[v];
    if (value === undefined) throw new Error(`service ${name}'s cmd names \${${v}}, which is not set in this process's environment`);
    return value;
  });
}

/**
 * A service's command as the supervisor runs it: the executable and its
 * arguments. The declared `cmd` is split on whitespace, with no quoting or
 * other shell syntax (a command that needs it belongs in a script), and each
 * word is then expanded by {@link expandServiceCommand}, so a variable whose
 * value has a space stays one word. sprite-env takes the arguments as one
 * comma-separated `--args`, so an argument with a comma in it is refused
 * here rather than split there. Pure.
 */
export function serviceCommandArgv(name: string, cmd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const words = cmd.trim().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) throw new Error(`service ${name}'s cmd is empty`);
  const argv = words.map((w) => expandServiceCommand(name, w, env));
  const comma = argv.slice(1).find((a) => a.includes(","));
  if (comma !== undefined) {
    throw new Error(`service ${name}'s cmd has the argument ${JSON.stringify(comma)}, and sprite-env's --args is comma-separated, so it can't carry a comma; run the command from a script`);
  }
  return argv;
}

/**
 * The services in an order each one's `needs` come before it, and in file
 * order otherwise. The list is one the declaration reader accepted, so every
 * `needs` is declared and none forms a cycle. Pure.
 */
export function inStartOrder<T extends { name: string; needs: readonly string[] }>(services: readonly T[]): T[] {
  const byName = new Map(services.map((s) => [s.name, s]));
  const done = new Set<string>();
  const out: T[] = [];
  const visit = (s: T) => {
    if (done.has(s.name)) return;
    done.add(s.name);
    for (const n of s.needs) {
      const dep = byName.get(n);
      if (dep) visit(dep);
    }
    out.push(s);
  };
  for (const s of services) visit(s);
  return out;
}
