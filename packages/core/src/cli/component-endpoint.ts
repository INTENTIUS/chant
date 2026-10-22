/**
 * The component plan and apply paths apply the environment's declared
 * endpoint before any capability runs (#4281), the way `--live` reads do
 * (`../live-endpoint.ts`).
 */

import { resolve } from "node:path";
import { loadChantConfig, type ChantConfig } from "../config";
import { withEnvironmentEndpoint, type EndpointLexicon } from "../live-endpoint";
import { formatWarning } from "./format";
import { loadPlugins, resolveProjectLexicons } from "./plugins";
import type { CommandContext } from "./registry";

/**
 * Run `run` with the declared endpoint of `environment` (default `--env`,
 * else `local`) applied to every project lexicon's endpoint var. `config` is
 * loaded from the working directory when not given. The project's plugins are
 * loaded only when the environment declares an endpoint and the command did
 * not load them; a project whose plugins can't load then stops, since running
 * on would reach the real cloud.
 */
export async function withComponentEndpoint<T>(
  ctx: Pick<CommandContext, "args" | "plugins">,
  run: () => Promise<T>,
  input: { config?: ChantConfig; environment?: string } = {},
): Promise<T> {
  const projectPath = resolve(".");
  const config = input.config ?? (await loadChantConfig(projectPath).catch(() => ({ config: {} as ChantConfig }))).config;
  const environment = input.environment ?? ctx.args.env ?? "local";
  const lexicons = async (): Promise<readonly EndpointLexicon[]> => {
    if (ctx.plugins.length > 0) return ctx.plugins;
    try {
      return await loadPlugins(await resolveProjectLexicons(projectPath));
    } catch (err) {
      throw new Error(
        `environment "${environment}" declares an endpoint, but the project's lexicons could not load to apply it: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  return withEnvironmentEndpoint(config.environments, environment, lexicons, run, {
    warn: (message) => console.error(formatWarning({ message })),
  });
}
