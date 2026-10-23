import { resolve } from "node:path";
import { build, mergeBuildRootEntities } from "../../build";
import { buildGraphIr, buildLiveGraphIr, collectUnobserved, sourceOverlayGraphs, type GraphIR, type IRNode, type IREdge } from "../../graph-ir";
import { buildDeclaredPerStack } from "../../graph-declared";
import { enrichEffectiveTopology, terraformResourceType } from "../../graph-effective";
import { reconstructEdges, mergeCatalogs, type ReferenceCatalog } from "../../graph-refs";
import { discover } from "../../discovery/index";

import { observeResources } from "../../lifecycle/observe";
import { replaySnapshots, hasSnapshot } from "../../lifecycle/replay";
import { diffLive, type LiveDiffResult } from "../../lifecycle/live-diff";
import type { LiveObservation } from "../../graph-ir";
import type { ResourceMetadata } from "../../lexicon";
import type { ObservationDepth } from "../../lifecycle/types";
import { formatUnobserved } from "../../observation";
import { loadChantConfig, matchesDeclaredEnvironment } from "../../config";
import { collectBuildRootContributors, loadPlugins, resolveProjectLexicons } from "../plugins";
import type { Declarable } from "../../declarable";
import { formatError, formatWarning } from "../format";
import type { CommandContext } from "../registry";

/**
 * `chant search <query> [--live --env <name>]` — answer an estate question with
 * a COMPACT result instead of the whole graph. The point (measured on aws-bench,
 * #1139): a small model shouldn't ingest a multi-thousand-token IR dump to answer
 * "which instances are in public subnets" — it should query and get a few rows.
 *
 * Query grammar (space-separated terms, all must match — AND):
 *   bare word            case-insensitive substring over id, kind, and attrs
 *   kind:<substr>        node kind contains <substr> (e.g. kind:EC2::Instance)
 *   tag:<key>=<val>      a Tags entry with Key=key and Value containing val
 *   attr:<name>=<val>    attribute <name> equals/contains <val>
 *   ->kind:X / ->attr:.. this node has an edge TO a node matching the right side
 *   <-kind:X / <-attr:.. this node has an edge FROM a node matching the right side
 *   ->*X, ->{n}X, ->{m,n}X  the far end is any depth / n / m..n hops away (#4359)
 *   ->[via=a]X, ->[to=a]X   only edges through consumer attr a / reading producer attr a
 *
 * The edge operators are the point of "edge-aware" search (#1139): a small
 * model shouldn't hand-join instance→subnet→public across many results — one
 * query does the traversal. `kind:Instance ->attr:MapPublicIpOnLaunch=true`
 * = instances that reference a public subnet.
 *
 * Output: one line per match — `<id>  <kind>  <key=val ...>` — with only the
 * physical id and any attributes named in `attr:`/`--show`. Tens of tokens, not
 * thousands.
 */
export async function runSearch(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const query = (args.path ?? "").trim();
  if (!query) {
    console.error(formatError({ message: "chant search needs a query: chant search \"<terms>\" [--live --env <name>]" }));
    return 1;
  }
  let terms: Term[];
  try {
    terms = parseQuery(query);
  } catch (err) {
    if (err instanceof QueryError) {
      console.error(formatError({ message: err.message, hint: err.hint }));
      return 1;
    }
    throw err;
  }
  const show = parseShow(args);

  // Query-scoped drift (#1268): --check-live checks a snapshot answer against
  // a live read, --check-snapshot checks a live answer against the recorded
  // snapshot — the direction each needs is the source it does NOT already have.
  if (args.checkLive && !args.at) {
    console.error(formatError({
      message: "chant search --check-live needs --at <ref>",
      hint: "answer from a snapshot and check the matched rows against a live read: --at latest --check-live --env <name>",
    }));
    return 1;
  }
  if (args.checkSnapshot && !args.live) {
    console.error(formatError({
      message: "chant search --check-snapshot needs --live",
      hint: "answer live and check the matched rows against the recorded snapshot: --live --check-snapshot --env <name>",
    }));
    return 1;
  }
  if (args.json && (args.checkLive || args.checkSnapshot)) {
    console.error(formatError({
      message: "chant search --json does not carry the --check-live/--check-snapshot report",
      hint: "run the drift check without --json; --json prints the matched rows and their paths",
    }));
    return 1;
  }
  if (args.failOnDrift && !args.checkLive && !args.checkSnapshot) {
    console.error(formatError({
      message: "chant search --fail-on-drift needs --check-live or --check-snapshot",
      hint: "it fails the check those flags run, so it is meaningless without one",
    }));
    return 1;
  }

  const projectPath = resolve(".");
  const { config } = await loadChantConfig(projectPath);

  let ir: GraphIR;
  let source: AnswerSource = { kind: "declared" };
  // Lexicons whose live read threw (#1263). "Nothing observed" and "could not
  // observe" are different claims; this is what carries the second one.
  const liveFailures: string[] = [];
  // Run-level notes from the read (#1265) — "ownership could not be filtered
  // on this path" — printed with the provenance footer, after the rows, so the
  // answer is not preceded by what qualifies it.
  let liveNotes: string[] = [];
  // Kinds that can exist in the account without being declared (#1278). Known
  // without a scan, so it costs nothing to mention.
  let ambientKinds: string[] = [];
  // Set only on a replay: whether the recording itself holds ambient resources.
  let replayAmbient: { recordedAmbient: boolean } | undefined;
  // Query-scoped drift (#1268): the OTHER observation, read only when
  // --check-live/--check-snapshot asked for one — the declared canvas to
  // classify against, and whether the exit code should reflect what it found.
  let checkObservations: LiveObservation[] | undefined;
  let primaryObservations: LiveObservation[] | undefined;
  let declaredForDrift: GraphIR | undefined;
  let snapshotDepth: ObservationDepth | undefined;
  let driftFailure = false;
  if (args.live || args.at) {
    const environment = args.env;
    if (!environment) {
      const flag = args.at ? "--at" : "--live";
      console.error(formatError({ message: `chant search ${flag} needs an environment: ${flag} --env <name>` }));
      return 1;
    }
    if (args.live && args.at) {
      // Two different observations of the same estate, and no rule for which
      // wins. Comparing them is a real question (#1268) but it is not this one.
      console.error(formatError({
        message: "chant search takes --live or --at, not both",
        hint: "--live reads the estate now; --at answers from a recorded snapshot",
      }));
      return 1;
    }
    // Membership via matchesDeclaredEnvironment (#1221): handles `{ name,
    // endpoint }` entries (#1166) — a plain `.includes` never matched those —
    // and glob-pattern entries like `"pr-*"`.
    if (config.environments && config.environments.length > 0 && !matchesDeclaredEnvironment(config.environments, environment)) {
      console.error(formatError({ message: `Unknown environment "${environment}"` }));
      return 1;
    }
    const plugins = ctx.plugins.length > 0 ? ctx.plugins : await loadPlugins(await resolveProjectLexicons(projectPath));
    const buildResult = await build(resolve(args.src ?? config.sourceDir ?? "."), plugins.map((p) => p.serializer), undefined, {
      config: config as unknown as Record<string, unknown>,
    });
    if (buildResult.errors.length > 0) {
      console.error(formatError({ message: "Build failed — fix errors before searching live state" }));
      return 1;
    }
    const observing = plugins.filter((p) => p.describeResources);
    ambientKinds = observing.flatMap((p) => p.ambientKinds?.() ?? []);
    const stacks = (config.stacks ?? []).map((s) => ({ name: s.name, region: s.region, src: s.src }));

    let observations: LiveObservation[];
    const liveAttrs: Record<string, Record<string, unknown>> = {};
    if (args.at) {
      // Answer from a recorded observation (#1266). Everything downstream is
      // the live path's — the point is that a snapshot replays into the same
      // shape a live read produces, so one pipeline serves both and a fold
      // improvement reaches an old snapshot for free.
      const scoped = new Set(stacks.filter((st) => st.src).map((st) => st.name));
      const replay = await replaySnapshots(environment, String(args.at), scoped);
      if ("error" in replay) {
        console.error(formatError({ message: replay.error, ...(replay.hint ? { hint: replay.hint } : {}) }));
        return 1;
      }
      observations = replay.observations;
      replayAmbient = {
        recordedAmbient: replay.observations.some((o) =>
          Object.values(o.resources).some((m) => m.ambient === true),
        ),
      };
      source = { kind: "snapshot", commit: replay.commit, timestamp: replay.timestamp };
      snapshotDepth = replay.depth;
      if (args.checkLive) {
        // A fresh live read, additional to the snapshot the answer itself came
        // from — this is what the matched rows get checked against.
        const liveCheck = await observeResources(environment, observing, buildResult, {
          owned: true,
          stacks,
          ambient: args.ambient === true,
        });
        for (const e of liveCheck.errors) {
          liveFailures.push(e);
          console.error(formatError({ message: `live read failed — ${e}` }));
        }
        checkObservations = liveCheck.observations;
      }
    } else {
      const observed = await observeResources(environment, observing, buildResult, {
        owned: true,
        stacks,
        ambient: args.ambient === true,
      });
      // A thrown read is not a warning. Printed as one, it sat between the
      // ownership-filter notices that also print on a working run and carried
      // no signal (#1263). Name the lexicon and the cause, as an error.
      for (const e of observed.errors) {
        liveFailures.push(e);
        console.error(formatError({ message: `live read failed — ${e}` }));
      }
      observations = observed.observations;
      liveNotes = observed.notes ?? [];
      source = { kind: "live" };
      if (args.checkSnapshot) {
        // The reverse direction: answer live, check the matched rows against
        // the most recently recorded snapshot. Missing entirely is not a
        // failure of THIS command — the live answer already stands — so it is
        // a note, not an error.
        const scoped = new Set(stacks.filter((st) => st.src).map((st) => st.name));
        const checkReplay = await replaySnapshots(environment, "latest", scoped);
        if ("error" in checkReplay) {
          console.error(formatWarning({ message: `--check-snapshot: ${checkReplay.error}` }));
        } else {
          checkObservations = checkReplay.observations;
          snapshotDepth = checkReplay.depth;
        }
      }
    }
    primaryObservations = observations;
    let live = buildLiveGraphIr(observations);
    // Containment edges, kept aside until after the overlay (see below).
    let containmentEdges: IREdge[] = [];
    // Live-only: enrichment is a provider call, so it has no place in a replay.
    // A recorded answer that quietly reached for the API would stop being one.
    if (!args.at) {
      for (const p of observing) {
        if (!p.enrichLiveAttrs) continue;
        try {
          const enriched = await p.enrichLiveAttrs({ environment, owned: true, stacks });
          for (const [id, a] of Object.entries(enriched)) liveAttrs[id] = { ...liveAttrs[id], ...a };
          live = { ...live, nodes: live.nodes.map((n) => (enriched[n.id] ? { ...n, attrs: { ...n.attrs, ...enriched[n.id] } } : n)) };
        } catch {
          /* enrichment is best-effort; search still works on describe attrs */
        }
      }
    }
    // Reconstruct edges from live references (#778), the same way `graph --live`
    // does (#1271). `buildLiveGraphIr` projects nodes only, so without this the
    // live side of the graph has no relationships at all — and a fold over
    // topology has nothing to traverse on anything the declared graph does not
    // already model.
    const catalogs = observing.map((p) => p.referenceCatalog).filter((c): c is ReferenceCatalog => !!c);
    // Held back until after the overlay — see where it is merged for why.
    if (catalogs.length > 0) {
      // Merge, never replace. A lexicon reports relationships a catalog cannot
      // reconstruct (#1273) — an instance placed in a subnet it did not declare
      // carries a template `Ref` in its attributes, not the physical subnet id,
      // so no identity index resolves it. Overwriting here dropped exactly those
      // edges and left the fold with a chain missing its first hop.
      // Containment travels with the references here, and only here. `->`/`<-`
      // asks which nodes reach which, and being inside something is a way of
      // reaching it: "which subnets have no network interfaces IN them" and
      // "which VPCs have no instances IN them" are containment questions, and
      // with only peer references to walk the negation matched everything.
      //
      // `graph` still reads `.containment` on its own and draws boundary boxes,
      // so nothing gains a line it did not have.
      const rebuilt = reconstructEdges(live.nodes, mergeCatalogs(catalogs));
      containmentEdges = rebuilt.containmentEdges;
      const reconstructed = rebuilt.edges;
      const seen = new Set((live.edges ?? []).map((e) => `${e.from}|${e.to}|${e.viaAttr ?? ""}`));
      live = {
        ...live,
        edges: [
          ...(live.edges ?? []),
          ...reconstructed.filter((e) => !seen.has(`${e.from}|${e.to}|${e.viaAttr ?? ""}`)),
        ],
      };
    }
    // Overlay live identity onto the SOURCE graph (same as `graph --overlay`):
    // the declared graph is the canvas — its edges carry the topology so ->/<-
    // resolves, while the live side supplies physical ids.
    //
    // Multi-stack (#1162): build the declared graph PER STACK (scoped to each
    // stack's src, the way it deploys) and stack-qualify node ids + edges as
    // `${stack}::${id}` — matching how observation qualifies. A flat whole-
    // project discovery would disambiguate colliding names by module path
    // (UsEast1Src…), which never matches the observed bare LogicalResourceIds.
    const declared =
      stacks.length > 0
        ? await buildDeclaredPerStack(stacks, projectPath)
        : buildGraphIr((await discover(resolve(args.src ?? config.sourceDir ?? "."))).entities, projectPath);
    declaredForDrift = declared;
    // Carry the NOT-OBSERVED half of the tri-state (#1089) onto the rows, so a
    // declared entity nobody could read is painted `_unobserved` and a row can
    // say so instead of printing blank where a physical id would go (#1263).
    ir = sourceOverlayGraphs(declared, live, { unobserved: collectUnobserved(observations) });
    // Containment goes on AFTER the overlay, not through it.
    //
    // `sourceOverlayGraphs` admits a live edge only when one end is foreign,
    // because "declared edges already cover every declared relationship". That
    // is true of the references it was written for and false of containment:
    // the declared canvas carries what the source *says*, and no source says
    // "this instance is in this VPC" — the instance declares a subnet, and the
    // VPC is implied by the account.
    //
    // So an instance and its VPC, both declared, had their containment dropped
    // between them, while an instance in the account's DEFAULT VPC kept it
    // because that VPC is foreign. "Which VPCs have no instances" answered
    // correctly for the one VPC nobody declared and wrongly for every VPC
    // somebody did.
    if (containmentEdges.length > 0) {
      const present = new Set(ir.nodes.map((n) => n.id));
      const seen = new Set(ir.edges.map((e) => `${e.from}|${e.to}|${e.viaAttr ?? ""}`));
      ir = {
        ...ir,
        edges: [
          ...ir.edges,
          ...containmentEdges.filter(
            (e) =>
              present.has(e.from) &&
              present.has(e.to) &&
              !seen.has(`${e.from}|${e.to}|${e.viaAttr ?? ""}`),
          ),
        ],
      };
    }
    // Carry live-derived attrs onto the declared canvas — some facts only exist
    // in live account state (e.g. `internetFacing` for an instance in the
    // account's default VPC, whose route table chant does not model). The
    // overlay copies physical identity but not attrs, so merge them here.
    ir = { ...ir, nodes: ir.nodes.map((n) => (liveAttrs[n.id] ? { ...n, attrs: { ...n.attrs, ...liveAttrs[n.id] } } : n)) };
  } else {
    const discovered = await discover(resolve(args.src ?? config.sourceDir ?? "."));
    await joinBuildRoots(discovered.entities, ctx, projectPath, config);
    ir = buildGraphIr(discovered.entities);
  }

  // Fold derived reachability facts (effectiveIngress, internetFacing) onto
  // instance nodes so multi-hop/launch-template joins are one node predicate (#1139).
  ir = enrichEffectiveTopology(ir);
  // Resolve `kind:` terms against what is actually in this graph, before any
  // node is tested against them.
  resolveKindTerms(terms, ir.nodes);
  const nodeById = new Map(ir.nodes.map((n) => [n.id, n]));
  const matches = ir.nodes.filter((n) => terms.every((t) => matchTerm(n, t, ir, nodeById)));
  // Machine-readable rows and paths (#4359), for a caller that draws them.
  if (args.json) {
    console.log(JSON.stringify(searchJson(query, source, matches, terms, ir, nodeById, liveFailures)));
    for (const n of liveNotes) console.error(formatWarning({ message: n }));
    return liveFailures.length > 0 ? 1 : 0;
  }
  if (matches.length === 0) {
    console.log("(no matches)");
    availableAttrs(terms, ir);
    if (args.explain) explain(terms, matches, ir, nodeById, query);
    for (const n of liveNotes) console.error(formatWarning({ message: n }));
    return 0;
  }
  for (const n of matches) {
    console.log(formatRow(n, show));
  }
  const backed = source.kind === "declared" || matches.some((n) => n.physicalId);
  // Only worth asking when the live read came back empty — that is the one case
  // where a recording changes what the caller should do next.
  const recorded =
    source.kind === "live" && !matches.some((n) => n.physicalId) && args.env
      ? (await hasSnapshot(String(args.env))) ? "yes" : undefined
      : undefined;
  provenance(matches, source, recorded, liveFailures, derivedUsed(terms, matches, ir));
  // Qualifies the provenance line, so it sits with it: one line per distinct
  // note for the whole run, not one per stack, and after the rows (#1265).
  for (const n of liveNotes) console.error(formatWarning({ message: n }));
  // Query-scoped drift (#1268): the matched rows, and only the matched rows,
  // checked against the observation the primary answer did NOT use. Scoping
  // both sides of diffLive() to the matched ids is what keeps a query-scoped-
  // out resource from reading as `missing` or `unobserved` — it was never
  // asked about, which is a third thing from both.
  if (checkObservations && declaredForDrift && primaryObservations) {
    const declaredIds = new Set(declaredForDrift.nodes.map((n) => n.id));
    const matchedIds = new Set(matches.map((n) => n.id));
    const nowObservations = args.checkLive ? checkObservations : primaryObservations;
    const thenObservations = args.checkLive ? primaryObservations : checkObservations;
    const driftCount = renderDrift(
      diffLive({
        declared: new Set([...matchedIds].filter((id) => declaredIds.has(id))),
        observedNow: pickResources(mergeResources(nowObservations), matchedIds),
        observedThen: pickResources(mergeResources(thenObservations), matchedIds),
        unobserved: pickResources(collectUnobserved(nowObservations), matchedIds),
      }),
      matches.length,
      args.checkLive ? "live" : "snapshot",
      snapshotDepth,
    );
    if (args.failOnDrift && driftCount > 0) driftFailure = true;
  }
  ambientHint(matches, ambientKinds, args.ambient === true, replayAmbient);
  showMiss(matches, show);
  regionSpread(terms, matches, show);
  derivedSurface(terms, matches, ir, backed);
  if (args.explain) explain(terms, matches, ir, nodeById, query);
  // The caller asked for a live answer and at least one lexicon could not be
  // read. The rows above are still printed — they are what the source declares,
  // labelled as such — but the command did not do what it was asked, and a
  // script or agent needs to see that without parsing the footer (#1263).
  if (liveFailures.length > 0) {
    console.error(formatError({
      message: `live read failed for ${liveFailures.length} lexicon${liveFailures.length === 1 ? "" : "s"} — answer is declared-only`,
      hint: recorded
        ? "answer from the recorded snapshot with --at latest, or drop --live for a declared-only query"
        : "drop --live for a declared-only query, or record a snapshot with chant lifecycle snapshot",
    }));
    return 1;
  }
  if (driftFailure) return 1;
  return 0;
}


/**
 * Join build-root entities (a terraform root's blocks, a rendered kustomize
 * root) to the discovered set, the way `chant graph` and `build()` do (#4362).
 * A terraform estate has no typed source at all, so without this a declared
 * search over one had nothing to search. Best-effort: a project whose lexicons
 * cannot be loaded is searched over its typed source alone, with a warning.
 */
async function joinBuildRoots(
  entities: Map<string, Declarable>,
  ctx: CommandContext,
  projectPath: string,
  config: object,
): Promise<void> {
  let plugins = ctx.plugins;
  if (plugins.length === 0) {
    try {
      plugins = await loadPlugins(await resolveProjectLexicons(projectPath));
    } catch {
      return;
    }
  }
  const contributors = collectBuildRootContributors(plugins, config as Record<string, unknown>, projectPath);
  if (contributors.length === 0) return;
  const merged = await mergeBuildRootEntities(entities, contributors);
  for (const message of [...merged.warnings, ...merged.errors]) console.error(formatWarning({ message }));
}

/** Where an answer's facts came from, for the provenance line (#1266). */
export type AnswerSource =
  | { kind: "declared" }
  | { kind: "live" }
  | { kind: "snapshot"; commit: string; timestamp: string };




/**
 * Name the `--show` columns nothing carries (#1279).
 *
 * A requested column that no matched resource has simply did not appear, so the
 * result looked like a resource with no such value rather than a name that was
 * never going to match. Combined with case sensitivity that made `--show
 * Region` an invisible no-op on an estate where every resource carries
 * `region`.
 */
function showMiss(matches: IRNode[], show: string[]): void {
  if (show.length === 0 || matches.length === 0) return;
  const present = new Set(
    matches.flatMap((n) => Object.keys((n.attrs ?? {}) as object).map((k) => k.toLowerCase())),
  );
  const missing = show.filter((k) => !present.has(k.toLowerCase()));
  if (missing.length === 0) return;
  console.log(`— no matched resource carries ${missing.join(", ")}`);
}

/**
 * Say when the answer spans more than one region (#1279).
 *
 * A result is a list of resources with no shape to it, and region is the one
 * dimension of this estate that is invisible in a row unless asked for. Asked
 * to list instances "in all regions", an agent printed six correct ids with no
 * region against any of them — a complete answer to a question about regions
 * that never mentions one, and it was judged wrong.
 *
 * Stated only when the matched set actually spans several and the caller has
 * not already asked: a fact about the result, in the same family as the
 * provenance line. It names the regions and no resource, so it cannot stand in
 * for the answer — it says the answer has a dimension, not what to say about it.
 */
function regionSpread(terms: Term[], matches: IRNode[], show: string[]): void {
  if (show.includes("region") || terms.some((t) => t.a === "region")) return;
  const regions = [
    ...new Set(
      matches
        .map((n) => (n.attrs as Record<string, unknown>)?.region)
        .filter((r): r is string => typeof r === "string" && r.length > 0),
    ),
  ].sort();
  if (regions.length < 2) return;
  console.log(`— these span ${regions.length} regions: ${regions.join(", ")} · add --show region to see which`);
}

/**
 * Point out that `--ambient` is relevant to the kind just queried (#1278).
 *
 * A resource nothing declares and nothing references is invisible to every
 * other observation path, so an answer about "my security groups" can be
 * complete for the declared estate and still not be the answer the question
 * wanted. The caller cannot know that from the result — it looks like the whole
 * set. An agent asked which groups were unused queried the three declared ones,
 * never learned three more existed, and spent twenty-five turns trying to
 * reconcile the shortfall from the graph.
 *
 * Says only that the flag applies to this kind, which is knowable without a
 * scan. It reports no count and names no resource, so it cannot stand in for
 * the answer.
 */
function ambientHint(
  matches: IRNode[],
  ambientKinds: string[],
  asked: boolean,
  replay?: { recordedAmbient: boolean },
): void {
  if (asked || ambientKinds.length === 0 || matches.length === 0) return;
  // On a replay the flag cannot change the answer: what is ambient in a
  // recording was fixed when it was recorded. Telling a caller to add
  // `--ambient` to `--at` is advice that does nothing — and when the snapshot
  // already holds ambient resources it is worse than nothing, because the
  // answer is complete and the hint says it is not. An agent read "6 of 6
  // matched" alongside it, went looking for a seventh, and hand-built a wrong
  // answer from the raw graph over twelve turns.
  if (replay) {
    if (!replay.recordedAmbient) {
      console.log(
        `— this snapshot recorded no ambient resources · re-record with \`chant lifecycle snapshot <env> --ambient\` to include them`,
      );
    }
    return;
  }
  const relevant = [...new Set(ambientKinds.filter((k) => matches.some((n) => n.kind === k)))];
  if (relevant.length === 0) return;
  const label = relevant.map((k) => k.split("::").slice(-1)[0]).join(", ");
  console.log(
    `— ${label} can also exist in the account without being declared or referenced; --ambient includes those`,
  );
}

/**
 * Say what backed this answer (#1266).
 *
 * Two things went wrong without it. A `--live` read that failed entirely
 * returned the declared graph, exit 0, with no physical ids and nothing to say
 * so — indistinguishable from a working live answer (#1263). And the derived
 * surface below named folds like `internetFacing` whether or not the
 * observation could support them, which is worse than saying nothing.
 *
 * It is also the most direct thing the tool can say to a caller deciding
 * whether to re-check with a raw provider sweep: the API has already been read,
 * and this many resources were bound to what it returned. A sweep repeats work
 * already done. That is a fact about the query, printed for every query, and it
 * encodes no expected answer.
 */
function provenance(
  matches: IRNode[],
  source: AnswerSource,
  recorded?: string,
  liveFailures: string[] = [],
  derived: string[] = [],
): void {
  if (source.kind === "declared") {
    // A derived fact the query relied on (#4362) was folded from declared
    // references alone, so it describes the source, not the account.
    const from = derived.length > 0 ? ` · ${derived.join(", ")} derived from declared references` : "";
    console.log(`— declared only · no observation · physical ids unavailable${from}`);
    return;
  }
  const bound = matches.filter((n) => n.physicalId).length;
  const what = source.kind === "live" ? "live read" : "snapshot";
  if (liveFailures.length > 0) {
    // Could not observe, as distinct from observed nothing. The rows carry the
    // per-entity verdict; this names the lexicons that failed in one line.
    const lexicons = liveFailures.map((e) => e.split(":")[0]).join(", ");
    const unobserved = matches.filter((n) => (n.attrs as Record<string, unknown> | undefined)?._unobserved).length;
    const rest = recorded
      ? "a snapshot of this environment is recorded — answer from it with --at latest"
      : "answered from the declared graph · physical ids unavailable";
    console.log(`— live read failed (${lexicons}) · ${unobserved}/${matches.length} rows unobserved · ${rest}`);
    return;
  }
  if (bound === 0) {
    // The estate was asked for and nothing came back bound. Naming it is the
    // difference between "these do not exist" and "nobody could see them".
    // A snapshot sitting unused is the actionable half of this. Denied network,
    // agents read six declared rows as a live answer and spent their turns
    // retrying `--live` — the tool knew the estate was unreachable AND that a
    // recording of it was on disk, and said only the first half.
    if (recorded) {
      console.log(
        `— ${what} returned no bound resources · a snapshot of this environment is recorded — answer from it with --at latest`,
      );
      return;
    }
    console.log(
      `— ${what} returned no bound resources · answered from the declared graph · physical ids unavailable`,
    );
    return;
  }
  if (source.kind === "live") {
    console.log(`— observed live · bound ${bound}/${matches.length}`);
    return;
  }
  // Time is the whole risk of a recorded answer, so it leads. A caller can see
  // how old this is and decide, rather than discovering staleness later.
  const taken = source.timestamp ? ` taken ${source.timestamp}` : "";
  const at = source.commit ? ` ${source.commit.slice(0, 7)}` : "";
  console.log(`— observed from snapshot${at}${taken} · bound ${bound}/${matches.length}`);
}

/** Union `LiveObservation.resources` across lexicons into one name-keyed map. */
function mergeResources(observations: LiveObservation[]): Record<string, ResourceMetadata> {
  const out: Record<string, ResourceMetadata> = {};
  for (const o of observations) Object.assign(out, o.resources);
  return out;
}

/** Restrict a name-keyed map to the matched ids — the whole of "query-scoped". */
function pickResources<T>(map: Record<string, T>, ids: Set<string>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const id of ids) if (id in map) out[id] = map[id];
  return out;
}

/**
 * Render the query-scoped drift check (#1268) — one line per matched resource
 * whose {@link diffLive} verdict is not `unchanged`, then a summary.
 *
 * Reuses `diffLive` unmodified, so every category means exactly what it means
 * in `lifecycle diff --live`: `missing`/`orphan`/`disappeared`/`drifted` count
 * as drift, the same set `lifecycle diff` totals; `newlyObserved` and runtime
 * children are reported but do not, and `unobserved` — a read that could not
 * look — stays distinct from both, the same #1089 tri-state everywhere else.
 */
function renderDrift(
  diff: LiveDiffResult,
  checked: number,
  direction: "live" | "snapshot",
  depth?: ObservationDepth,
): number {
  for (const name of diff.missing) console.log(`⚠ ${name} — missing (declared, not found by this check)`);
  for (const name of diff.orphan) console.log(`⚠ ${name} — orphan (observed, not declared)`);
  for (const name of diff.disappeared) console.log(`⚠ ${name} — disappeared since the recorded snapshot`);
  for (const drift of diff.driftedSinceSnapshot) {
    for (const change of drift.changes) {
      console.log(`⚠ ${drift.name}  ${change.path}: ${formatValue(change.oldValue)} → ${formatValue(change.newValue)} — drifted`);
    }
  }
  for (const name of diff.newlyObserved) console.log(`  · ${name} — newly observed since the recorded snapshot`);
  for (const r of diff.runtimeChildren) console.log(`  · ${r.name} (${r.type}) — runtime, owned by ${r.owner}`);
  for (const u of diff.unobserved) console.log(`  ? ${formatUnobserved(u.name, u)}`);
  const driftCount = diff.missing.length + diff.orphan.length + diff.disappeared.length + diff.driftedSinceSnapshot.length;
  const label = direction === "live" ? "a live read" : "the recorded snapshot";
  const depthNote = depth === "deep" ? " · snapshot recorded at deep depth, compared here at identity" : "";
  console.log(
    `— checked against ${label} · ${driftCount > 0 ? `${driftCount} of ${checked} matched drifted` : `no drift across ${checked} matched`}${depthNote}`,
  );
  return driftCount;
}

function formatValue(v: unknown): string {
  if (v === undefined) return "<unset>";
  if (typeof v === "string") return v.length > 60 ? v.slice(0, 57) + "..." : v;
  const json = JSON.stringify(v);
  return json.length > 60 ? json.slice(0, 57) + "..." : json;
}

/**
 * Name the facts chant computed for the kinds in this result that the query did not use.
 *
 * A provider API can only return what it stores; chant additionally folds multi-hop topology
 * onto a node, and a caller has no way to know that surface exists. Reporting it turns a
 * one-shot query into a conversation with the graph — ask something, learn what else is
 * knowable about the same resources, refine.
 *
 * The names come from {@link GraphIR.derivedAttrs}, recorded by whichever enrichment pass
 * produced them. Nothing here knows what any attribute means or which question it answers;
 * add a pass and its facts appear, remove one and they stop.
 */
function derivedSurface(terms: Term[], matches: IRNode[], ir: GraphIR, backed = true): void {
  const derived = ir.derivedAttrs;
  // A fold over live topology has nothing to report when the observation came
  // back empty (#1263). Naming the surface anyway advertises facts this answer
  // could not have computed, which is worse than saying nothing at all.
  if (!derived || matches.length === 0 || !backed) return;
  const used = new Set(terms.filter((t) => t.kind === "attr").map((t) => t.a));
  const unused = new Set<string>();
  for (const n of matches) for (const name of derivedNames(n, ir)) if (!used.has(name)) unused.add(name);
  if (unused.size === 0) return;
  console.log(`— also derived for these resources: ${[...unused].sort().join(", ")}`);
}

/** The derived attributes recorded for a node's kind (or its terraform resource type, #4362). */
function derivedNames(n: IRNode, ir: GraphIR): string[] {
  const tfType = terraformResourceType(n);
  return Object.entries(ir.derivedAttrs ?? {})
    .filter(([kind]) => n.kind?.includes(kind) || kind === tfType)
    .flatMap(([, names]) => names);
}

/** The derived attributes the query's `attr:` terms relied on, for the provenance line. */
function derivedUsed(terms: Term[], matches: IRNode[], ir: GraphIR): string[] {
  const queried = new Set(terms.filter((t) => t.kind === "attr" && !t.negated).map((t) => t.a));
  const out = new Set<string>();
  for (const n of matches) for (const name of derivedNames(n, ir)) if (queried.has(name)) out.add(name);
  return [...out].sort();
}

/**
 * `--explain` footer (#1139): a compact, model-DERIVED summary that gives a
 * small model a reason to trust the result instead of re-deriving it with a
 * lossy CLI sweep. It reports the universe count ("4 of 6 Instances") — chant's
 * structural edge, since the typed graph knows the denominator a live sweep
 * doesn't — and, for the near-miss set, WHY each was excluded (which query term
 * it fails). Everything here is a property of the query over the graph, not of
 * any expected answer, so it stays a fair, question-agnostic capability.
 */
function explain(terms: Term[], matches: IRNode[], ir: GraphIR, byId: Map<string, IRNode>, query: string): void {
  const kinds = new Set(matches.map((n) => n.kind).filter((k): k is string => !!k));
  const universe = kinds.size > 0 ? ir.nodes.filter((n) => n.kind && kinds.has(n.kind)) : ir.nodes;
  const matched = new Set(matches.map((n) => n.id));
  const excluded = universe.filter((n) => !matched.has(n.id));
  const kindLabel = kinds.size > 0 ? [...kinds].join("/") : "nodes";
  console.log(`— ${matches.length} of ${universe.length} ${kindLabel} matched  (query: ${query})`);
  // Inclusion evidence: for a derived fact a CLI can't easily re-verify
  // (internetFacing, resolved across the default VPC's routing), name WHY each
  // match qualifies, so the agent trusts the result instead of dropping it.
  for (const t of terms) {
    if (t.kind !== "attr") continue;
    for (const n of matches) {
      const via = (n.attrs as Record<string, unknown> | undefined)?.[`${t.a}Via`];
      const id = n.id.includes("::") ? n.id.slice(n.id.lastIndexOf("::") + 2) : n.id;
      if (typeof via === "string") console.log(`  ✓ ${id} ${t.a} via ${via}`);
    }
  }
  // The chain each match was reached by (#4359), so a caller can quote the
  // path instead of re-deriving it with one search per hop.
  for (const n of matches) {
    for (const p of matchPaths(n, terms, ir, byId)) console.log(`  path ${formatPath(p.hops, p.term.dir!)}`);
  }
  const shown = excluded.slice(0, 8);
  for (const n of shown) {
    const failing = terms.find((t) => !matchTerm(n, t, ir, byId));
    const id = n.id.includes("::") ? n.id.slice(n.id.lastIndexOf("::") + 2) : n.id;
    console.log(`  · excluded ${id} — fails ${failing ? describeTerm(failing) : "(query)"}`);
  }
  if (excluded.length > shown.length) console.log(`  · …and ${excluded.length - shown.length} more excluded`);
}

/**
 * On a miss, name the attributes the queried kind actually carries. A graph knows
 * its own schema, so a caller who guessed an attribute name — or did not know a
 * derived one existed — can see what is queryable instead of falling back to a
 * lossy CLI sweep. Read off the nodes present, so it stays a property of the
 * graph rather than of any expected answer: whatever the estate holds is what
 * this lists, and it says nothing about which attribute answers a question.
 */
function availableAttrs(terms: Term[], ir: GraphIR): void {
  const kindTerm = terms.find((t) => t.kind === "kind");
  if (!kindTerm) return;
  const of = ir.nodes.filter((n) => n.kind?.includes(kindTerm.a));
  if (of.length === 0) return;
  const names = new Set<string>();
  for (const n of of) for (const k of Object.keys((n.attrs as Record<string, unknown>) ?? {})) names.add(k);
  const queried = new Set(terms.filter((t) => t.kind === "attr").map((t) => t.a));
  const unused = [...names].filter((k) => !queried.has(k)).sort();
  if (unused.length > 0) {
    console.log(`  · ${of.length} ${kindTerm.a} node(s) carry: ${unused.join(", ")}`);
  }

  // A queried attribute that EXISTS but matched nothing is the more useful
  // miss to explain, and it was the one left silent: the list above omits
  // anything the caller asked about, so querying a real attribute with an
  // unmatchable value taught nothing at all. A caller reaching for a wildcard —
  // `attr:effectiveIngress=*tcp:22:0.0.0.0/0`, which this grammar has no
  // operator for — got "(no matches)" and concluded the tool had nothing.
  for (const term of terms) {
    if (term.kind !== "attr" || term.b === undefined || !names.has(term.a)) continue;
    const values = new Set<string>();
    for (const n of of) {
      const v = (n.attrs as Record<string, unknown> | undefined)?.[term.a];
      for (const one of Array.isArray(v) ? v : [v]) {
        if (one !== undefined && one !== null) values.add(String(one));
      }
    }
    if (values.size === 0) continue;
    const sample = [...values].sort().slice(0, 8);
    const more = values.size > sample.length ? `, … ${values.size - sample.length} more` : "";
    console.log(`  · ${term.a} is present but no value matched "${term.b}" — values seen: ${sample.join(", ")}${more}`);
  }
}

function describeTerm(t: Term): string {
  // `--explain` has to say a negated term was negated, or an exclusion reads as
  // the opposite of what it is.
  if (t.negated) return `!${describeTerm({ ...t, negated: false })}`;
  if (t.kind === "edge") return `${edgeOperator(t, { out: "→", in: "←" })}${t.sub ? leafText(t.sub) : ""} (no such edge)`;
  return leafText(t);
}

function leafText(x: Term): string {
  return x.kind === "kind" ? `kind:${x.a}` : x.kind === "attr" ? `attr:${x.a}${x.b !== undefined ? "=" + x.b : ""}`
    : x.kind === "tag" ? `tag:${x.a}${x.b !== undefined ? "=" + x.b : ""}` : `"${x.a}"`;
}

/**
 * `chant search --json` (#4359): the matched rows and, per positive edge
 * term, the path each match was reached by. Drawn by behold (behold#913).
 *
 *   {
 *     "query": "kind:aws_instance ->*kind:aws_vpc",
 *     "source": { "kind": "declared" | "live" | "snapshot", "commit"?, "timestamp"? },
 *     "matches": [
 *       { "id": "web", "kind": "aws_instance", "physicalId"?: "i-1", "unobserved"?: "read-failed",
 *         "paths": [ { "term": "->*kind:aws_vpc", "dir": "out",
 *                      "hops": [ { "from": "web", "fromAttr": "subnet_id", "to": "a", "toAttr": "id" },
 *                                { "from": "a", "fromAttr": "vpc_id", "to": "main", "toAttr": "id" } ] } ] }
 *     ],
 *     "liveFailures"?: ["aws: ..."]
 *   }
 *
 * `hops` is in walk order from the match; each hop keeps the edge's own
 * direction (see {@link PathHop}). `paths` is empty when the query has no
 * positive edge term. Ids are the graph's full ids.
 */
export interface SearchJson {
  query: string;
  source: AnswerSource;
  matches: {
    id: string;
    kind?: string;
    physicalId?: string;
    unobserved?: string;
    paths: { term: string; dir: "out" | "in"; hops: PathHop[] }[];
  }[];
  liveFailures?: string[];
}

function searchJson(
  query: string,
  source: AnswerSource,
  matches: IRNode[],
  terms: Term[],
  ir: GraphIR,
  byId: Map<string, IRNode>,
  liveFailures: string[] = [],
): SearchJson {
  return {
    query,
    source,
    matches: matches.map((n) => {
      const attrs = (n.attrs ?? {}) as Record<string, unknown>;
      const physical = (n as { physicalId?: unknown }).physicalId ?? attrs["physicalId"] ?? attrs["InstanceId"] ?? attrs["Id"];
      return {
        id: n.id,
        ...(n.kind ? { kind: n.kind } : {}),
        ...(physical != null && typeof physical !== "object" ? { physicalId: String(physical) } : {}),
        ...(typeof attrs["_unobserved"] === "string" ? { unobserved: attrs["_unobserved"] } : {}),
        paths: matchPaths(n, terms, ir, byId).map((p) => ({
          term: `${edgeOperator(p.term, { out: "->", in: "<-" })}${p.term.sub ? leafText(p.term.sub) : ""}`,
          dir: p.term.dir!,
          hops: p.hops,
        })),
      };
    }),
    ...(liveFailures.length > 0 ? { liveFailures } : {}),
  };
}

export interface Term {
  kind: "word" | "kind" | "tag" | "attr" | "edge";
  /** `!term` — the node must NOT satisfy this (#1280). */
  negated?: boolean;
  a: string;
  b?: string;
  /** For edge terms: the direction and the sub-predicate matched at the far end. */
  dir?: "out" | "in";
  sub?: Term;
  /**
   * For edge terms (#4359): how many hops the far end may be away. Absent on a
   * plain `->`/`<-`, which is exactly one hop. `max` is `Infinity` for `*`.
   */
  depth?: { min: number; max: number };
  /** For edge terms (#4359): every edge on the path goes through this consumer attribute (`IREdge.viaAttr`). */
  viaAttr?: string;
  /** For edge terms (#4359): every edge on the path reads this producer attribute (`IREdge.toAttr`). */
  toAttr?: string;
  /**
   * For kind terms: the kinds this term actually means, resolved against the
   * graph (see {@link resolveKindTerms}). Absent when nothing resolved it, in
   * which case the substring rule applies unchanged.
   */
  kinds?: Set<string>;
}

/**
 * Decide which kinds a `kind:` term means, given what is in the graph.
 *
 * `kind:` is documented as a substring, and substrings of a CloudFormation type
 * cross kind boundaries: `kind:EC2::VPC` also matches
 * `AWS::EC2::VPCGatewayAttachment`, and `kind:EC2::Subnet` also matches
 * `AWS::EC2::SubnetRouteTableAssociation`. An estate with 6 VPCs answers 9, and
 * the caller has no reason to suspect the number they were given.
 *
 * That cost real answers. Asked how many VPCs have no instances, agents named
 * the right VPCs and reported "9 VPCs in the estate" beside them; the grader
 * failed the answer for contradicting the estate, which it did.
 *
 * So: a term that lines up with `::` boundaries means those kinds and only
 * those. `EC2::VPC` is the last two segments of `AWS::EC2::VPC` and is not any
 * run of segments in `AWS::EC2::VPCGatewayAttachment`, because
 * `VPCGatewayAttachment` is not `VPC`.
 *
 * Substring is kept as the fallback, so `kind:Gateway` still finds both
 * `InternetGateway` and `VPCGatewayAttachment` — a genuine substring search
 * that no segment rule would serve. Most specific wins; nothing else changes.
 */
export function resolveKindTerms(terms: Term[], nodes: IRNode[]): void {
  const present = [...new Set(nodes.map((n) => n.kind).filter((k): k is string => !!k))];
  const walk = (t: Term): void => {
    if (t.sub) walk(t.sub);
    if (t.kind !== "kind") return;
    const want = t.a.toLowerCase().split("::").filter(Boolean);
    if (want.length === 0) return;
    const onBoundary = present.filter((k) => {
      const have = k.toLowerCase().split("::");
      for (let i = 0; i + want.length <= have.length; i++) {
        if (want.every((w, j) => have[i + j] === w)) return true;
      }
      return false;
    });
    if (onBoundary.length > 0) t.kinds = new Set(onBoundary);
  };
  terms.forEach(walk);
}

function parseLeaf(tok: string): Term {
  const m = /^(kind|tag|attr):(.*)$/i.exec(tok);
  if (m) {
    const key = m[1].toLowerCase() as Term["kind"];
    const rest = m[2];
    const eq = rest.indexOf("=");
    if (eq >= 0) return { kind: key, a: rest.slice(0, eq), b: rest.slice(eq + 1) };
    return { kind: key, a: rest };
  }
  // `name:value` with a prefix the grammar does not have. This parsed as a
  // free-text word and matched nothing, which is the worst available outcome:
  // an agent looking for SSH reachability wrote
  // `effectiveIngress:tcp:22:0.0.0.0/0` — the right idea, the right attribute,
  // the wrong spelling — got a clean empty result, concluded chant did not hold
  // the fact, and rebuilt the answer by hand from security-group rows. An empty
  // result must never be the reply to a question the grammar could not read.
  //
  // `::` and `://` are excluded so a genuine word search for `AWS::EC2::Instance`
  // or a URL still works — a real prefix is one colon, not two.
  const bad = /^([A-Za-z][A-Za-z0-9_]*):(?![:/])/.exec(tok);
  if (bad) {
    const name = bad[1];
    const value = tok.slice(name.length + 1);
    throw new QueryError(
      `"${tok}" is not a term — there is no "${name}:" prefix`,
      `for an attribute, say attr:${name}=${value || "<value>"}; the prefixes are kind:, attr:, tag:, and ->/<- for edges`,
    );
  }
  return { kind: "word", a: tok };
}

/** A query the grammar cannot accept, carrying the correction to print. */
class QueryError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

/**
 * Parse an edge term (#4359): `->` or `<-`, then an optional depth, then an
 * optional attribute qualifier, then the target leaf.
 *
 *   ->kind:X                one hop, as it always was
 *   ->*kind:X               any number of hops, one or more
 *   ->{3}kind:X             exactly three hops
 *   ->{1,3}kind:X           one to three hops ({2,} is two or more)
 *   <-[via=vpc_id]kind:X    only edges through the consumer attribute vpc_id
 *   ->[to=id]kind:X         only edges that read the producer attribute id
 *   <-*[via=subnet_id]      a qualifier may stand without a target: any node
 *
 * A qualifier constrains every edge on the path, not only the first one.
 */
function parseEdge(tok: string, negated: boolean): Term {
  const dir = tok.startsWith("->") ? ("out" as const) : ("in" as const);
  const arrow = tok.slice(0, 2);
  let rest = tok.slice(2);
  const term: Term = { kind: "edge", a: "", dir };
  if (rest.startsWith("*")) {
    term.depth = { min: 1, max: Infinity };
    rest = rest.slice(1);
  } else if (rest.startsWith("{")) {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(rest);
    const min = m ? Number(m[1]) : NaN;
    const max = !m ? NaN : m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
    if (!m || min < 1 || max < min) {
      throw new QueryError(
        `"${tok}" has a depth this grammar cannot read`,
        `a depth is {n}, {min,max} or {min,} with 1 <= min <= max, e.g. ${arrow}{1,3}kind:aws_vpc; ${arrow}* is any depth`,
      );
    }
    term.depth = { min, max };
    rest = rest.slice(m[0].length);
  }
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    const parts = close < 0 ? [""] : rest.slice(1, close).split(",").map((p) => p.trim());
    for (const part of parts) {
      const q = /^(via|to)=(.+)$/.exec(part);
      if (!q) {
        throw new QueryError(
          `"${tok}" has an edge qualifier this grammar cannot read`,
          `qualify an edge by attribute with [via=<consumer attr>] or [to=<producer attr>], e.g. <-[via=vpc_id]kind:aws_subnet or ->[via=subnet_id,to=id]`,
        );
      }
      if (q[1] === "via") term.viaAttr = q[2];
      else term.toAttr = q[2];
    }
    rest = rest.slice(close + 1);
  }
  if (rest.trim() === "") {
    if (term.viaAttr === undefined && term.toAttr === undefined) {
      const bang = negated ? "!" : "";
      throw new QueryError(
        `"${bang}${tok}" needs a target`,
        `say what the edge reaches: ${bang}${tok}kind:EC2::Instance, or qualify it by attribute: ${bang}${tok}[via=vpc_id]`,
      );
    }
    return term;
  }
  return { ...term, sub: parseLeaf(rest) };
}

function parseQuery(query: string): Term[] {
  // Split on whitespace but keep quoted phrases together.
  const tokens = query.match(/"[^"]*"|\S+/g) ?? [];
  return tokens.map((raw) => {
    let tok = raw.replace(/^"|"$/g, "");
    // A leading `!` negates the term (#1280). Absence is a real estate
    // question — "which security groups does nothing reference", "which
    // subnets hold no instances" — and the grammar could only express
    // presence, so the one question a graph is uniquely good at needed a
    // provider sweep and a hand-built set difference.
    const negated = tok.startsWith("!");
    if (negated) tok = tok.slice(1);
    // An edge term needs a target. A bare `<-` used to parse to an empty leaf
    // and quietly match something arbitrary — an agent wrote
    // `kind:EC2::SecurityGroup !<-` meaning "referenced by nothing" and got a
    // silently wrong set. Refusing it is right beyond the parse bug too:
    // "referenced by nothing at all" and "referenced by no Instance" are
    // different questions, and on any estate whose declared graph carries
    // references they give different answers.
    // A bare edge term is refused, and the refusal names the correction.
    //
    // It first parsed to an empty leaf and matched arbitrarily. The fix was to
    // refuse it; then, because agents kept writing `!<-` for "what is unused",
    // it was made to mean "no edge in this direction" — which is a coherent
    // query and still the wrong one to answer that question with. It counts
    // every reference in the project, and a stack output that publishes a
    // resource's id is one, so `kind:EC2::SecurityGroup !<-` omits precisely
    // the unattached group the question was about.
    //
    // Measured both ways: refusing it, agents wrote `!<-kind:EC2::Instance` and
    // got the right answer 3/3; accepting it, they wrote `!<-` and got a wrong
    // one 2 runs out of 3. A query whose plain reading is reliably not what the
    // caller means is worth refusing, and the correction below is what makes
    // the refusal useful rather than merely strict.
    if (/^(->|<-)\s*$/.test(tok)) {
      throw new QueryError(
        `"${negated ? "!" : ""}${tok}" needs a target`,
        `say what the edge reaches: ${negated ? "!" : ""}${tok}kind:EC2::Instance, or ${negated ? "!" : ""}${tok}attr:Name=web`,
      );
    }
    const term: Term = tok.startsWith("->") || tok.startsWith("<-") ? parseEdge(tok, negated) : parseLeaf(tok);
    return negated ? { ...term, negated: true } : term;
  });
}

function parseShow(args: { show?: string }): string[] {
  return args.show ? args.show.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

function attrString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") {
    // AttrRef placeholder ({$ref}) or nested — stringify shallowly.
    return JSON.stringify(v);
  }
  return String(v);
}

function matchTerm(n: IRNode, t: Term, ir?: GraphIR, byId?: Map<string, IRNode>): boolean {
  if (t.negated) return !matchTerm(n, { ...t, negated: false }, ir, byId);
  const attrs = n.attrs ?? {};
  if (t.kind === "edge") {
    if (!ir || !byId) return false;
    // Depth and attribute qualifiers (#4359) go through the path search. A
    // plain one-hop term keeps the original code below, unchanged.
    if (t.depth || t.viaAttr !== undefined || t.toAttr !== undefined) return findPath(n, t, ir, byId) !== null;
    if (!t.sub) return false;
    // A node matches if it has an edge (out or in) to a node satisfying `sub`.
    const edges = ir.edges ?? [];
    const neighbors = edges
      .filter((e) => (t.dir === "out" ? e.from === n.id : e.to === n.id))
      .map((e) => byId.get(t.dir === "out" ? e.to : e.from))
      .filter((x): x is IRNode => !!x);
    return neighbors.some((m) => matchTerm(m, t.sub!, ir, byId));
  }
  if (t.kind === "kind") {
    // Resolved kinds when the term lined up with `::` boundaries; the
    // documented substring otherwise.
    if (t.kinds) return t.kinds.has(n.kind ?? "");
    return (n.kind ?? "").toLowerCase().includes(t.a.toLowerCase());
  }
  if (t.kind === "attr") {
    const val = attrString((attrs as Record<string, unknown>)[t.a]);
    return t.b === undefined ? t.a in attrs : val.toLowerCase().includes(t.b.toLowerCase());
  }
  if (t.kind === "tag") {
    const tags = (attrs as Record<string, unknown>)["Tags"];
    if (!Array.isArray(tags)) return false;
    return tags.some((tag) => {
      const key = attrString((tag as Record<string, unknown>)?.Key);
      const val = attrString((tag as Record<string, unknown>)?.Value);
      return key.toLowerCase() === t.a.toLowerCase() && (t.b === undefined || val.toLowerCase().includes(t.b.toLowerCase()));
    });
  }
  // bare word: substring over id, kind, and all attr values
  const hay = [n.id, n.kind, ...Object.values(attrs).map(attrString)].join(" ").toLowerCase();
  return hay.includes(t.a.toLowerCase());
}

/**
 * One edge on the path a match was reached by (#4359), in walk order from the
 * match outward. `from` and `to` keep the edge's own direction (`from` holds
 * the reference, `to` is what it names), whichever way the term walked, so a
 * reader can find the edge in the graph by its endpoints. Node ids are the
 * graph's full ids, stack qualification included.
 */
export interface PathHop {
  from: string;
  /** The consumer attribute the reference flows through (`IREdge.viaAttr`), when known. */
  fromAttr?: string;
  to: string;
  /** The producer attribute read (`IREdge.toAttr`), when known. */
  toAttr?: string;
}

const adjacency = new WeakMap<GraphIR, { out: Map<string, IREdge[]>; in: Map<string, IREdge[]> }>();

function edgeIndex(ir: GraphIR): { out: Map<string, IREdge[]>; in: Map<string, IREdge[]> } {
  let idx = adjacency.get(ir);
  if (!idx) {
    idx = { out: new Map(), in: new Map() };
    for (const e of ir.edges ?? []) {
      if (!idx.out.has(e.from)) idx.out.set(e.from, []);
      idx.out.get(e.from)!.push(e);
      if (!idx.in.has(e.to)) idx.in.set(e.to, []);
      idx.in.get(e.to)!.push(e);
    }
    adjacency.set(ir, idx);
  }
  return idx;
}

function sameName(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

/**
 * The shortest path by which an edge term reaches `n` (#4359), or null.
 *
 * Breadth-first over the edges in the term's direction, keeping only edges
 * whose attributes satisfy its qualifier, and accepting a node that satisfies
 * the target leaf (any node when the term has none) at a depth inside the
 * term's range. A plain `->`/`<-` is the range 1..1.
 *
 * Termination on a cycle: a state is (node, depth capped at the range's
 * minimum). Past the minimum, arriving at a node again by a longer walk can
 * reach nothing the first arrival could not, so it is not queued twice. The
 * state space is finite and the walk always ends.
 */
function findPath(n: IRNode, t: Term, ir: GraphIR, byId: Map<string, IRNode>): PathHop[] | null {
  if (t.kind !== "edge") return null;
  const { min, max } = t.depth ?? { min: 1, max: 1 };
  const idx = edgeIndex(ir);
  const out = t.dir === "out";
  type State = { id: string; depth: number; hops: PathHop[] };
  const seen = new Set<string>([`${n.id}|0`]);
  let frontier: State[] = [{ id: n.id, depth: 0, hops: [] }];
  while (frontier.length > 0) {
    const next: State[] = [];
    for (const s of frontier) {
      if (s.depth >= max) continue;
      for (const e of (out ? idx.out.get(s.id) : idx.in.get(s.id)) ?? []) {
        if (t.viaAttr !== undefined && !sameName(e.viaAttr, t.viaAttr)) continue;
        if (t.toAttr !== undefined && !sameName(e.toAttr, t.toAttr)) continue;
        const farId = out ? e.to : e.from;
        const far = byId.get(farId);
        if (!far) continue;
        const depth = s.depth + 1;
        const hop: PathHop = {
          from: e.from,
          ...(e.viaAttr ? { fromAttr: e.viaAttr } : {}),
          to: e.to,
          ...(e.toAttr ? { toAttr: e.toAttr } : {}),
        };
        const hops = [...s.hops, hop];
        if (depth >= min && (!t.sub || matchTerm(far, t.sub, ir, byId))) return hops;
        const key = `${farId}|${Math.min(depth, min)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        next.push({ id: farId, depth, hops });
      }
    }
    frontier = next;
  }
  return null;
}

function bareId(id: string): string {
  return id.includes("::") ? id.slice(id.lastIndexOf("::") + 2) : id;
}

/**
 * A path as one line of `id.attr` steps, read from the match outward (#4359).
 * Walking `->`, each hop reads `consumer.via -> producer.attr`; walking `<-`,
 * `producer.attr <- consumer.via`. Hops are joined with `; `.
 */
function formatPath(hops: PathHop[], dir: "out" | "in"): string {
  const end = (id: string, attr?: string): string => (attr ? `${bareId(id)}.${attr}` : bareId(id));
  return hops
    .map((h) =>
      dir === "out"
        ? `${end(h.from, h.fromAttr)} -> ${end(h.to, h.toAttr)}`
        : `${end(h.to, h.toAttr)} <- ${end(h.from, h.fromAttr)}`,
    )
    .join("; ");
}

/** The edge operator as written: arrow, depth and qualifier, no target. */
function edgeOperator(t: Term, arrows: { out: string; in: string }): string {
  const arrow = t.dir === "out" ? arrows.out : arrows.in;
  const depth = !t.depth
    ? ""
    : t.depth.min === 1 && t.depth.max === Infinity
      ? "*"
      : t.depth.min === t.depth.max
        ? `{${t.depth.min}}`
        : `{${t.depth.min},${t.depth.max === Infinity ? "" : t.depth.max}}`;
  const quals = [
    ...(t.viaAttr !== undefined ? [`via=${t.viaAttr}`] : []),
    ...(t.toAttr !== undefined ? [`to=${t.toAttr}`] : []),
  ];
  return `${arrow}${depth}${quals.length > 0 ? `[${quals.join(",")}]` : ""}`;
}

/** Each positive edge term's path to `n`, in query order (#4359). */
function matchPaths(n: IRNode, terms: Term[], ir: GraphIR, byId: Map<string, IRNode>): { term: Term; hops: PathHop[] }[] {
  const out: { term: Term; hops: PathHop[] }[] = [];
  for (const t of terms) {
    if (t.kind !== "edge" || t.negated) continue;
    const hops = findPath(n, t, ir, byId);
    if (hops) out.push({ term: t, hops });
  }
  return out;
}

function formatRow(n: IRNode, show: string[]): string {
  const attrs = (n.attrs ?? {}) as Record<string, unknown>;
  // Display the bare logical id, not the `${stack}::` qualification (#1162).
  const displayId = n.id.includes("::") ? n.id.slice(n.id.lastIndexOf("::") + 2) : n.id;
  const parts: string[] = [displayId, n.kind ?? ""];
  // Prefer the node-level live physicalId (set by the overlay), then attrs;
  // skip source-mode AttrRef placeholders (objects).
  const physical = (n as { physicalId?: unknown }).physicalId ?? attrs["physicalId"] ?? attrs["InstanceId"] ?? attrs["Id"];
  if (physical != null && typeof physical !== "object") parts.push(String(physical));
  // A row nobody could read says so where its physical id would go (#1263). A
  // blank there reads as "declared, not provisioned", which the read never
  // established; the reason is the tri-state's (#1089).
  else if (typeof attrs["_unobserved"] === "string") parts.push(`(unobserved: ${attrs["_unobserved"]})`);
  for (const key of show) {
    // Match the name case-insensitively, and report what was actually found.
    // AWS attribute names are PascalCase and chant's derived ones are not, so a
    // caller mixing them is normal: `--show region` and `--show Region` are the
    // same request, and one of them silently printed nothing. Seven of the
    // `--show` names in one benchmark run missed on case alone.
    const actual = key in attrs ? key : Object.keys(attrs).find((k) => k.toLowerCase() === key.toLowerCase());
    const v = actual == null ? undefined : attrs[actual];
    if (v == null) continue;
    // A column the caller explicitly asked for is shown whatever shape it is.
    // Skipping non-scalars silently meant `--show effectiveIngress` — the
    // derived reachability fact, and the reason to reach for chant at all —
    // printed a blank column, because it is a list. The agent read that as
    // "chant does not have this" and hand-rolled the answer from raw
    // security-group rows, which is exactly the work the fold exists to avoid.
    parts.push(`${actual}=${typeof v === "object" ? JSON.stringify(v) : attrString(v)}`);
  }
  return parts.filter(Boolean).join("  ");
}

/** Internals exposed for unit tests. */
export const __searchInternals = { parseQuery, matchTerm, findPath, formatPath, searchJson, formatRow, explain, describeTerm, derivedSurface, availableAttrs, ambientHint, regionSpread, showMiss, provenance, renderDrift, mergeResources, pickResources };
