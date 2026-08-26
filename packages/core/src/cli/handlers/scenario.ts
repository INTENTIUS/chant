import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { commandBuildParams } from "../build-params-cli";
import { build, type BuildResult } from "../../build";
import { readEnvironmentSnapshots, fetchLifecycle } from "../../lifecycle/git";
import { buildChangeSet, type ChangeSet, type ChangeSetEntry } from "../../lifecycle/change-set";
import {
  planReceipts,
  mergeReceiptEntries,
  observedValueResolver,
  readReceiptValue,
  type ReceiptReading,
} from "../../lifecycle/receipt-plan";
import { collectEffectReceipts, isEffectReceipt, type EffectReceiptDeclaration } from "../../effect-receipt";
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
import type { ResourceMetadata } from "../../lexicon";

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
 *
 * Effect receipts (#1832) get the same replacement `runLifecyclePlan` gives
 * them: `collectEffectReceipts` pulls every declared receipt out of the
 * generic axis, `evaluateOneScenario` builds a {@link ReceiptReading} per
 * receipt from the SAME fixture data that stands in for `observed.resources`/
 * `observed.unobserved` elsewhere in this function, and `planReceipts` +
 * `mergeReceiptEntries` (../../lifecycle/receipt-plan.ts) replace whatever the
 * generic classification proposed for a receipt with its real `effect`
 * classification — never a bare create/noop. A receipt whose reading can't be
 * derived from the fixture (its lexicon has no fixture data, or a reference
 * input the receipt depends on isn't among the fixture's recorded attributes)
 * is classified exactly the way `runLifecyclePlan` classifies it: an
 * unreadable receipt lands `unobserved`, loudly; a receipt whose reference
 * input can't resolve still proposes the fire, with an "unresolved input"
 * note, never a guessed digest.
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

  // Same read surface `runLifecyclePlan` uses (lifecycle.ts) — computed once,
  // ahead of the per-scenario loop, since it's a property of the build, not
  // of any one scenario's fixture.
  const receipts = collectEffectReceipts(buildResult.entities);

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
    const { verdict, env } = await evaluateOneScenario(scenario, buildResult, receipts);
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
 *
 * Effect receipts (#1832) get the same treatment `runLifecyclePlan` gives
 * them (lifecycle.ts:1145,1184,1213-1242,1278-1280): a receipt joins the
 * declared axis alongside ordinary resources, a {@link ReceiptReading} is
 * built per receipt from the SAME fixture data (`observedNow`/`unobserved`)
 * every other entity in this loop reads, and `planReceipts` +
 * `mergeReceiptEntries` replace whatever the generic classification proposed
 * for the receipt with the real `effect` classification before the change set
 * ever reaches `evaluateScenario` — an unfired receipt never reads as a bare
 * `create`, and a stale one never reads as a clean `noop`.
 */
async function evaluateOneScenario(
  scenario: ScenarioDeclaration,
  buildResult: BuildResult,
  receipts: ReadonlyMap<string, EffectReceiptDeclaration>,
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
    // A receipt has no `props` payload of its own but is declared, diffed,
    // and observed like any resource (#1832) — it joins the declared axis so
    // its lexicon's fixture data can confirm presence, absence, or a hole,
    // the same as `runLifecyclePlan` (lifecycle.ts:1184).
    if (!isResourceDeclarable(entity) && !isEffectReceipt(entity)) continue;
    if (!declaredByLexicon.has(entity.lexicon)) declaredByLexicon.set(entity.lexicon, new Set());
    declaredByLexicon.get(entity.lexicon)!.add(name);
  }

  // Every fixture lexicon's `resources` merged, for resolving a receipt's
  // reference inputs against the fixture the same way `runLifecyclePlan`
  // resolves them against its merged live observation (lifecycle.ts:1149,1213).
  const allObservedResources: Record<string, ResourceMetadata> = {};
  const receiptReadings = new Map<string, ReceiptReading>();

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

    Object.assign(allObservedResources, observedNow);
    for (const [receiptName, receipt] of receipts) {
      if (receipt.lexicon !== lexiconName) continue;
      const live = observedNow[receiptName];
      const hole = unobserved[receiptName];
      if (live) {
        receiptReadings.set(receiptName, {
          observed: true,
          present: true,
          value: readReceiptValue(live.attributes),
          type: live.type,
          ...(live.physicalId ? { physicalId: live.physicalId } : {}),
          lexicon: lexiconName,
        });
      } else if (hole) {
        receiptReadings.set(receiptName, {
          observed: false,
          present: false,
          lexicon: lexiconName,
          ...(hole.type ? { type: hole.type } : {}),
          unobservedReason: hole.reason,
          ...(hole.detail ? { unobservedDetail: hole.detail } : {}),
        });
      } else {
        // Neither in the fixture's resources nor named unobserved: the
        // fixture stands in for a live read that confirmed the receipt
        // absent — the same claim `buildChangeSet` reads off a bare
        // observation (#1089).
        receiptReadings.set(receiptName, { observed: true, present: false, lexicon: lexiconName });
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

  const merged: ChangeSet = { env: resolved.env, entries };
  // Receipt classification (#1832): replace whatever the generic pass above
  // proposed for a receipt — a `create` for one confirmed absent, a `noop`
  // for one present but stale — with the real `effect` classification, the
  // same replacement `runLifecyclePlan` performs (lifecycle.ts:1278-1280).
  if (receipts.size > 0) {
    const receiptEntries = planReceipts(receipts, receiptReadings, observedValueResolver(allObservedResources));
    mergeReceiptEntries(merged, receipts, receiptEntries);
  }

  return { env: resolved.env, verdict: evaluateScenario(merged, scenario.expect) };
}

/** Fallback for `chant scenario <unknown subcommand>` — mirrors `runLifecycleUnknown`. */
export async function runScenarioUnknown(ctx: CommandContext): Promise<number> {
  console.error(formatError({
    message: `Unknown scenario subcommand: ${ctx.args.extraPositional ?? ctx.args.path}`,
    hint: "Available: chant scenario check",
  }));
  return 1;
}
