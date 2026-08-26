import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { commandBuildParams } from "../build-params-cli";
import { build, type BuildResult } from "../../build";
import { readEnvironmentSnapshots, fetchLifecycle } from "../../lifecycle/git";
import { buildChangeSet, type ChangeSetEntry } from "../../lifecycle/change-set";
import { evaluateScenario, type ScenarioVerdict } from "../../lifecycle/scenario-eval";
import { collectScenarios, type ScenarioDeclaration, type ScenarioGiven } from "../../lifecycle/scenario";
import { isResourceDeclarable } from "../../declarable";
import { loadChantConfig } from "../../config";
import { unknownEnvError } from "../../env";
import { collectBuildRootContributors } from "../plugins";
import { resolveBuildRoot } from "./lifecycle";
import { formatError, formatSuccess, formatBold } from "../format";
import type { CommandContext } from "../registry";
import type { LifecycleSnapshot } from "../../lifecycle/types";
import type { UnobservedEntity } from "../../observation";

/**
 * `chant scenario check` (#1292) — evaluate every declared `Scenario`
 * offline, against a fixture snapshot standing in for live observation.
 *
 * Mirrors `runLifecyclePlan` (./lifecycle.ts): build the project, walk every
 * lexicon's declared entities, produce a `ChangeSet`. The one substitution is
 * the whole point — a scenario's `given` fixture stands in for
 * `observeLexicon`'s live read, so no plugin ever makes a network call and no
 * credentials are ever asked for. `evaluateScenario` (../../lifecycle/scenario-eval.ts)
 * checks the resulting change set against the scenario's `expect`.
 *
 * A scenario has exactly one fixture, not a before-and-after pair, so the
 * change set it produces never has an `observedThen` to diff against — the
 * `update` count is therefore always 0. That is a real, not a placeholder,
 * limitation of what a single-snapshot scenario can assert: presence
 * (`create`/`delete`/`noop`) and ownership are fully expressive here; drift
 * since a prior read is not, because there is no prior read in this model,
 * only the one fixture.
 */
export async function runScenarioCheck(ctx: CommandContext): Promise<number> {
  const { args, plugins, serializers } = ctx;

  const { config } = await loadChantConfig(resolve("."));
  const declaredParams = await commandBuildParams(config.buildParams, args);
  if (!declaredParams) return 1;

  const buildResult = await build(resolveBuildRoot(args, config), serializers, undefined, {
    buildParams: declaredParams,
    buildRoots: collectBuildRootContributors(plugins, config as unknown as Record<string, unknown>, resolve(".")),
  });
  if (buildResult.errors.length > 0) {
    console.error(formatError({ message: "Build failed — fix errors before checking scenarios" }));
    return 1;
  }

  const scenarios = collectScenarios(buildResult.entities);
  if (scenarios.size === 0) {
    console.log("No scenarios declared — nothing to check.");
    return 0;
  }

  // `snapshot(env)` reads the chant/lifecycle orphan branch — fetch once,
  // up front, the same pre-read `runLifecyclePlan` does, rather than once per
  // scenario that needs it.
  if ([...scenarios.values()].some((s) => s.given.kind === "env")) {
    await fetchLifecycle();
  }

  const results: Array<{ entityName: string; scenario: ScenarioDeclaration; verdict: ScenarioVerdict; env: string }> = [];
  for (const [entityName, scenario] of scenarios) {
    if (scenario.given.kind === "env") {
      const envErr = unknownEnvError(scenario.given.env, config.environments);
      if (envErr) {
        results.push({
          entityName,
          scenario,
          env: scenario.given.env,
          verdict: { pass: false, checks: [{ clause: "given", pass: false, detail: envErr }] },
        });
        continue;
      }
    }
    const { verdict, env } = await evaluateOneScenario(scenario, buildResult);
    results.push({ entityName, scenario, verdict, env });
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        results.map((r) => ({ name: r.scenario.name, entity: r.entityName, env: r.env, ...r.verdict })),
        null,
        2,
      ),
    );
  } else {
    for (const r of results) printResult(r.entityName, r.scenario, r.env, r.verdict);
  }

  const failed = results.filter((r) => !r.verdict.pass).length;
  const total = results.length;
  if (failed > 0) {
    console.error(formatError({ message: `${failed}/${total} scenario(s) failed` }));
    return 1;
  }
  console.log(formatSuccess(`${total}/${total} scenario(s) passed`));
  return 0;
}

function printResult(entityName: string, scenario: ScenarioDeclaration, env: string, verdict: ScenarioVerdict): void {
  const status = verdict.pass ? formatSuccess("PASS") : "FAIL";
  console.log(`\n${formatBold(scenario.name)} [${entityName}] — given ${describeGiven(scenario.given)}${env ? `, env ${env}` : ""}: ${status}`);
  for (const check of verdict.checks) {
    if (check.pass) continue;
    console.log(`  ${check.clause}: ${check.detail ?? "failed"}`);
  }
}

/** Human-readable rendering of a scenario's `given`, for output and error messages. */
function describeGiven(given: ScenarioGiven): string {
  return given.kind === "file" ? given.path : `env "${given.env}"`;
}

interface GivenResolution {
  env: string;
  /** Fixture data per lexicon it covers. Empty when nothing could be read. */
  perLexicon: Map<string, LifecycleSnapshot>;
  /** Set when the fixture itself could not be resolved — the scenario fails on this alone. */
  error?: string;
}

/** Read `given`'s fixture data. Offline: a file read for `snapshot(path)`, a
 * git-plumbing read of the already-fetched orphan branch for `snapshot(env)` —
 * never a live provider call. */
async function resolveGiven(given: ScenarioGiven): Promise<GivenResolution> {
  if (given.kind === "file") {
    const abs = resolve(given.path);
    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch {
      return { env: "", perLexicon: new Map(), error: `fixture not found: ${given.path}` };
    }
    let snap: LifecycleSnapshot;
    try {
      snap = JSON.parse(raw) as LifecycleSnapshot;
    } catch {
      return { env: "", perLexicon: new Map(), error: `fixture is not valid JSON: ${given.path}` };
    }
    if (typeof snap.lexicon !== "string" || typeof snap.environment !== "string" || typeof snap.resources !== "object") {
      return {
        env: typeof snap.environment === "string" ? snap.environment : "",
        perLexicon: new Map(),
        error: `${given.path} is not a LifecycleSnapshot — missing lexicon/environment/resources`,
      };
    }
    return { env: snap.environment, perLexicon: new Map([[snap.lexicon, snap]]) };
  }

  const stored = await readEnvironmentSnapshots(given.env);
  if (stored.size === 0) {
    return {
      env: given.env,
      perLexicon: new Map(),
      error: `no recorded snapshot for environment "${given.env}" on chant/lifecycle — record one with \`chant lifecycle snapshot ${given.env}\``,
    };
  }
  const perLexicon = new Map<string, LifecycleSnapshot>();
  for (const [key, content] of stored) {
    const snap = JSON.parse(content) as LifecycleSnapshot;
    perLexicon.set(snap.lexicon ?? key, snap);
  }
  return { env: given.env, perLexicon };
}

/**
 * Build the merged change set for one scenario and evaluate it. A lexicon the
 * fixture has no data for is never silently read as "nothing declared, all
 * absent" — every entity it declares is marked `unobserved` (#1089's own
 * discipline: a hole the fixture cannot fill is a hole, not a guess).
 */
async function evaluateOneScenario(
  scenario: ScenarioDeclaration,
  buildResult: BuildResult,
): Promise<{ verdict: ScenarioVerdict; env: string }> {
  const resolved = await resolveGiven(scenario.given);
  if (resolved.error) {
    return {
      env: resolved.env,
      verdict: { pass: false, checks: [{ clause: "given", pass: false, detail: resolved.error }] },
    };
  }

  const declaredByLexicon = new Map<string, Set<string>>();
  for (const [name, entity] of buildResult.entities) {
    if (!isResourceDeclarable(entity)) continue;
    if (!declaredByLexicon.has(entity.lexicon)) declaredByLexicon.set(entity.lexicon, new Set());
    declaredByLexicon.get(entity.lexicon)!.add(name);
  }

  const lexicons = new Set<string>([...declaredByLexicon.keys(), ...resolved.perLexicon.keys()]);
  const entries: ChangeSetEntry[] = [];
  for (const lexiconName of lexicons) {
    const declared = declaredByLexicon.get(lexiconName) ?? new Set<string>();
    const fixture = resolved.perLexicon.get(lexiconName);
    const observedNow = fixture?.resources ?? {};
    const unobserved: Record<string, UnobservedEntity> = { ...(fixture?.unobserved ?? {}) };
    if (!fixture) {
      for (const name of declared) {
        if (!(name in unobserved)) {
          unobserved[name] = {
            reason: "filtered",
            detail: `given ${describeGiven(scenario.given)} has no recorded data for lexicon "${lexiconName}"`,
          };
        }
      }
    }
    // No `observedThen`: a scenario has one fixture, standing in for live
    // observation only — never a second, prior read to diff against. See this
    // module's top comment on what that means for `update`.
    const cs = buildChangeSet(
      resolved.env,
      { declared, observedNow, observedThen: undefined, unobserved },
      { lexicon: lexiconName },
    );
    entries.push(...cs.entries);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  return { env: resolved.env, verdict: evaluateScenario({ env: resolved.env, entries }, scenario.expect) };
}

/** Fallback for `chant scenario <unknown subcommand>` — mirrors `runLifecycleUnknown`. */
export async function runScenarioUnknown(ctx: CommandContext): Promise<number> {
  console.error(formatError({
    message: `Unknown scenario subcommand: ${ctx.args.extraPositional ?? ctx.args.path}`,
    hint: "Available: chant scenario check",
  }));
  return 1;
}
