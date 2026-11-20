/**
 * `chant lifecycle health <env> [lexicon] [--json]` (#4177): whether each
 * declared resource that has a health read is up, separate from drift.
 *
 * It builds the project as `lifecycle diff` does, so the entity names are the
 * graph's node ids, then asks each lexicon with a health read about the
 * entities whose types it names. An environment's declared endpoint is applied
 * for the read, as on the other live reads (#1166).
 *
 * A terraform root or a pulumi stack is read through the provider lexicons
 * (#5338): the engine lexicon's `healthTargets` maps each resource of a
 * covered type to its provider's health type and the id from the root's
 * state or the stack's export, and the provider's `observeHealth` reads it.
 * A provider lexicon the project does not configure is loaded when it is
 * installed.
 *
 * The JSON is the {@link HEALTH_SCHEMA} shape. A single-stack project prints
 * `lexicons` at the top level; a multi-stack one nests them under `stacks`,
 * the same split `lifecycle diff --live --json` makes.
 */

import { resolve } from "node:path";
import { build } from "../../build";
import { loadChantConfig } from "../../config";
import { isObservableDeclarable } from "../../declarable";
import {
  HEALTH_SCHEMA,
  healthApplicable,
  observeEngineHealth,
  observeHealthFor,
  summarizeHealth,
  type EngineHealthLexicon,
  type HealthLexicon,
  type HealthReadResult,
} from "../../health";
import type { LexiconPlugin } from "../../lexicon";
import { applyLiveEndpoint } from "../../live-endpoint";
import type { SerializerResult } from "../../serializer";
import { CHANT_VERSION } from "../version";
import { commandBuildParams } from "../build-params-cli";
import { resolveBuildModes, resolveProjectBuildOptions } from "../build-options";
import { formatBold, formatError, formatWarning } from "../format";
import type { CommandContext } from "../registry";
import { resolveStackTargets } from "./lifecycle";

type ByLexicon = Record<string, HealthReadResult>;

export async function runLifecycleHealth(ctx: CommandContext): Promise<number> {
  const { args, plugins } = ctx;
  const environment = args.extraPositional;
  const lexiconFilter = args.extraPositional2;
  if (!environment) {
    console.error(formatError({ message: "Environment is required: chant lifecycle health <environment> [lexicon]" }));
    return 1;
  }

  const readers = plugins.filter(
    (p) =>
      ((p.observeHealth && (p.healthTypes?.length ?? 0) > 0) || p.healthTargets) &&
      (!lexiconFilter || p.name === lexiconFilter),
  );
  if (readers.length === 0) {
    console.error(formatWarning({
      message: lexiconFilter
        ? `${lexiconFilter}: no health read in this lexicon`
        : "No configured lexicon has a health read (aws, azure and gcp do, and terraform and pulumi through them)",
    }));
    return 1;
  }
  const provider = providerLookup(plugins);

  const projectRoot = resolve(".");
  const { config } = await loadChantConfig(projectRoot);
  const declaredParams = await commandBuildParams(config.buildParams, args);
  if (!declaredParams) return 1;
  const targets = resolveStackTargets(args, config);
  const buildOptions = resolveProjectBuildOptions({
    config,
    configDir: projectRoot,
    plugins,
    modes: resolveBuildModes(config, { fold: args.fold, sandbox: args.sandbox }),
    buildParams: declaredParams,
  });
  const serializers = readers.map((p) => p.serializer);

  const endpoint = applyLiveEndpoint(config.environments, environment, readers);
  if (endpoint.notice) console.error(formatWarning({ message: endpoint.notice }));

  const perStack: Record<string, ByLexicon> = {};
  let single: ByLexicon | undefined;
  let anyBuildError = false;
  const observedAt = new Date().toISOString();

  try {
    for (const target of targets) {
      const buildResult = await build(target.root, serializers, undefined, buildOptions);
      if (buildResult.errors.length > 0) {
        console.error(formatError({
          message: `Build failed for ${target.stack ? `stack "${target.stack}"` : "project"}; fix errors before reading health`,
        }));
        anyBuildError = true;
        continue;
      }
      const byLexicon: ByLexicon = {};
      for (const plugin of readers) {
        const declared = new Map<string, { entityType: string; props: Record<string, unknown> }>();
        for (const [name, entity] of buildResult.entities) {
          if (entity.lexicon === plugin.name && isObservableDeclarable(entity)) {
            declared.set(name, {
              entityType: entity.entityType,
              props: (entity.props != null ? entity.props : {}) as Record<string, unknown>,
            });
          }
        }
        const raw = buildResult.outputs.get(plugin.name);
        const buildOutput = raw === undefined ? "" : typeof raw === "string" ? raw : (raw as SerializerResult).primary;
        const scope = {
          environment,
          buildOutput,
          ...(target.stack ? { stack: target.stack } : {}),
          ...(target.region ? { region: target.region } : {}),
        };
        if (plugin.healthTargets) {
          if (declared.size === 0) continue;
          const { result, error } = await observeEngineHealth(plugin as EngineHealthLexicon, { ...scope, entities: declared }, provider);
          if (error) console.error(formatWarning({ message: `${plugin.name}: the health targets could not be read: ${error}` }));
          if (Object.keys(result.entities).length + Object.keys(result.unobserved).length + result.absent.length > 0) {
            byLexicon[plugin.name] = result;
          }
          continue;
        }
        const entities = healthApplicable(plugin as HealthLexicon, declared);
        if (entities.size === 0) continue;
        byLexicon[plugin.name] = await observeHealthFor(plugin as HealthLexicon, { ...scope, entities });
      }
      if (target.stack) perStack[target.stack] = byLexicon;
      else single = byLexicon;
    }
  } finally {
    endpoint.restore();
  }

  const all = single ? [single] : Object.values(perStack);
  const summary = summarizeHealth(all.flatMap((b) => Object.values(b)));

  if (args.json) {
    console.log(JSON.stringify({
      schema: HEALTH_SCHEMA,
      chantVersion: CHANT_VERSION,
      environment,
      observedAt,
      ...(single ? { lexicons: single } : { stacks: perStack }),
      summary,
    }));
  } else {
    if (single) renderHealth(single);
    else for (const [stack, byLexicon] of Object.entries(perStack)) {
      console.log(`\n${formatBold(`■ stack ${stack}`)}`);
      renderHealth(byLexicon);
    }
    const total = summary.healthy + summary.unhealthy + summary.unknown + summary.unobserved + summary.absent;
    if (total === 0) {
      console.error(formatWarning({ message: "No declared resource has a health read" }));
    } else {
      console.error(
        `${summary.healthy} healthy, ${summary.unhealthy} unhealthy, ${summary.unknown} unknown` +
          (summary.unobserved > 0 ? `, ${summary.unobserved} not observed` : "") +
          (summary.absent > 0 ? `, ${summary.absent} not deployed` : ""),
      );
    }
  }
  return anyBuildError ? 1 : 0;
}

/**
 * The provider lexicon an engine's target names: a configured one, else the
 * installed package, loaded once. Undefined when it is not installed.
 */
function providerLookup(plugins: readonly LexiconPlugin[]): (lexicon: string) => Promise<HealthLexicon | undefined> {
  const loaded = new Map<string, Promise<HealthLexicon | undefined>>();
  return (lexicon) => {
    const configured = plugins.find((p) => p.name === lexicon);
    if (configured) return Promise.resolve(configured as HealthLexicon);
    let pending = loaded.get(lexicon);
    if (!pending) {
      pending = import("../plugins").then(({ loadPlugin }) => loadPlugin(lexicon) as Promise<HealthLexicon>).catch(() => undefined);
      loaded.set(lexicon, pending);
    }
    return pending;
  };
}

function renderHealth(byLexicon: ByLexicon): void {
  for (const [lexicon, result] of Object.entries(byLexicon)) {
    console.log(formatBold(lexicon));
    for (const [name, entry] of Object.entries(result.entities)) {
      console.log(`  ${entry.state.padEnd(9)} ${name} (${entry.type}): ${entry.detail}`);
    }
    for (const [name, hole] of Object.entries(result.unobserved)) {
      console.log(`  ${"not read".padEnd(9)} ${name}${hole.type ? ` (${hole.type})` : ""}: ${hole.reason}${hole.detail ? `, ${hole.detail}` : ""}`);
    }
    for (const name of result.absent) console.log(`  ${"absent".padEnd(9)} ${name}: not deployed`);
  }
}
