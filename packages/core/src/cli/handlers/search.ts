import { resolve } from "node:path";
import { build } from "../../build";
import { buildGraphIr, buildLiveGraphIr, collectUnobserved, sourceOverlayGraphs, type GraphIR, type IRNode, type IREdge } from "../../graph-ir";
import { buildDeclaredPerStack } from "../../graph-declared";
import { enrichEffectiveTopology, terraformResourceType, terraformType } from "../../graph-effective";
import { attachCapabilities, attachView, capabilityEngine, parseCapabilityCall } from "../../capabilities/catalog";
import { CapabilityError, type CapabilityEngine, type Evidence } from "../../capabilities/matcher";
import type { CapabilityPack, View } from "../../capabilities/view";
import { reconstructEdges, mergeCatalogs, type ReferenceCatalog } from "../../graph-refs";
import { discover } from "../../discovery/index";

import { carryAnnotations, observeResources } from "../../lifecycle/observe";
import { replaySnapshots, hasSnapshot } from "../../lifecycle/replay";
import { diffLive, type LiveDiffResult } from "../../lifecycle/live-diff";
import type { LiveObservation } from "../../graph-ir";
import type { LexiconPlugin, ResourceMetadata } from "../../lexicon";
import type { ObservationDepth } from "../../lifecycle/types";
import { formatUnobserved } from "../../observation";
import { readChantPackageVersion } from "../../package-version";
import { loadChantConfig, matchesDeclaredEnvironment } from "../../config";
import { collectBuildRootContributors, loadPlugins, resolveProjectLexicons } from "../plugins";
import { declaredBuildRootContributors, mergeDeclaredBuildRoots, withLexiconEdges } from "./declared-graph";
import { parseCountBy, countGroups, countsJson, formatCounts, hasManyTerraformRoots, type CountBy } from "./search-count";
import { formatError, formatWarning } from "../format";
import type { CommandContext } from "../registry";
import { SEARCH_CONTRACT_VERSION, SEARCH_OUTPUT_SCHEMA_ID, type SearchErrorCode, type SearchFailure, type SearchHead } from "../../workspace/search-contract";

/**
 * `chant search <query> [--live --env <name>]` — answer an estate question with
 * a COMPACT result instead of the whole graph. The point (measured on aws-bench,
 * #1139): a small model shouldn't ingest a multi-thousand-token IR dump to answer
 * "which instances are in public subnets" — it should query and get a few rows.
 *
 * Query grammar (space-separated terms, all must match — AND):
 *   bare word            case-insensitive substring over id, kind, and attrs
 *   kind:<substr>        node kind contains <substr> (e.g. kind:EC2::Instance);
 *                        on a terraform resource, its type (kind:aws_instance, kind:aws_iam_)
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
  // A refusal (#4367): the error on stderr as always, and under --json the
  // same message and hint as the one document on stdout, so a program reading
  // stdout sees why there are no rows. Exit 1 either way. The code is from the
  // read contract's closed list (#4374).
  const refuse = (error: { code: SearchErrorCode; message: string; hint?: string }): number => {
    console.error(formatError(error));
    if (args.json) console.log(JSON.stringify(searchErrorJson(query, error)));
    return 1;
  };
  // The capability catalog (#4375): the `capabilities` document, not an answer.
  if (args.capabilities) return printCapabilities(args, query, await resolveProjectLexicons(resolve(".")).catch(() => []));
  // The snapshot to replay (#4374): `--snapshot <ref>`, or `--at <ref>`, which
  // plain search keeps for compatibility. Everywhere else in the read contract
  // `--at` is a git revision, so the workspace form takes only `--snapshot`.
  if (args.snapshot !== undefined && args.at !== undefined && String(args.snapshot) !== String(args.at)) {
    return refuse({
      code: "usage-invalid",
      message: `chant search was given --snapshot ${args.snapshot} and --at ${args.at}`,
      hint: "they name the same thing, the recorded snapshot to answer from; give one",
    });
  }
  const snapshotRef: string | undefined = args.snapshot ?? (args.at !== undefined ? String(args.at) : undefined);
  const snapshotFlag = args.snapshot !== undefined ? "--snapshot" : "--at";
  const checked = checkSearchArgs(args, query, { ref: snapshotRef, flag: snapshotFlag });
  if ("error" in checked) return refuse(checked.error);
  const { terms, countBy } = checked;
  const show = parseShow(args);

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
  // Why --check-snapshot had nothing to check against, for --json (#4367).
  let driftUnavailable: string | undefined;
  if (args.live || snapshotRef) {
    // checkSearchArgs refused a live or snapshot read without one.
    const environment = String(args.env);
    // Membership via matchesDeclaredEnvironment (#1221): handles `{ name,
    // endpoint }` entries (#1166) — a plain `.includes` never matched those —
    // and glob-pattern entries like `"pr-*"`.
    if (config.environments && config.environments.length > 0 && !matchesDeclaredEnvironment(config.environments, environment)) {
      return refuse({ code: "environment-unknown", message: `Unknown environment "${environment}"` });
    }
    const plugins = ctx.plugins.length > 0 ? ctx.plugins : await loadPlugins(await resolveProjectLexicons(projectPath));
    // Build roots too (#4358), as `chant graph --live` does: a terraform
    // root's blocks are entities only once its root is rendered, and an
    // entity the build never produced is never observed.
    const buildRoots = collectBuildRootContributors(plugins, config as unknown as Record<string, unknown>, projectPath);
    const buildResult = await build(resolve(args.src ?? config.sourceDir ?? "."), plugins.map((p) => p.serializer), undefined, {
      buildRoots,
      config: config as unknown as Record<string, unknown>,
    });
    if (buildResult.errors.length > 0) {
      return refuse({ code: "build-failed", message: "Build failed — fix errors before searching live state" });
    }
    const observing = plugins.filter((p) => p.describeResources);
    ambientKinds = observing.flatMap((p) => p.ambientKinds?.() ?? []);
    const stacks = (config.stacks ?? []).map((s) => ({ name: s.name, region: s.region, src: s.src }));

    let observations: LiveObservation[];
    // Facts about absent entities (#4372): a planned create's plan attributes.
    let annotations: Record<string, Record<string, unknown>> | undefined;
    const liveAttrs: Record<string, Record<string, unknown>> = {};
    if (snapshotRef) {
      // Answer from a recorded observation (#1266). Everything downstream is
      // the live path's — the point is that a snapshot replays into the same
      // shape a live read produces, so one pipeline serves both and a fold
      // improvement reaches an old snapshot for free.
      const scoped = new Set(stacks.filter((st) => st.src).map((st) => st.name));
      const replay = await replaySnapshots(environment, snapshotRef, scoped);
      if ("error" in replay) {
        return refuse({ code: "snapshot-unavailable", message: replay.error, ...(replay.hint ? { hint: replay.hint } : {}) });
      }
      observations = replay.observations;
      replayAmbient = {
        recordedAmbient: replay.observations.some((o) =>
          Object.values(o.resources).some((m) => m.ambient === true),
        ),
      };
      source = { kind: "snapshot", snapshot: snapshotRef, commit: replay.commit, timestamp: replay.timestamp };
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
      annotations = observed.annotations;
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
          driftUnavailable = checkReplay.error;
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
    if (!snapshotRef) {
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
    //
    // The flat canvas is the declared path's graph (#4365, #4358): discovery
    // plus the build-root contributions (a terraform root's blocks, a rendered
    // kustomize root) plus the lexicon edges, so a live answer over a Terraform
    // root overlays onto a canvas that has the root's resources on it.
    const declared =
      stacks.length > 0
        ? await buildDeclaredPerStack(stacks, projectPath, (g, entities) => withLexiconEdges(g, plugins, entities))
        : await declaredGraph(ctx, projectPath, resolve(args.src ?? config.sourceDir ?? "."), plugins);
    if (!declared) return refuse(BUILD_ROOT_FAILED);
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
    // And what the read learned about an entity it found absent (#4372), so
    // `attr:planAction=create` matches a block the plan will create. The node
    // stays pending: only its attributes change.
    ir = { ...ir, nodes: carryAnnotations(ir.nodes, annotations) };
  } else {
    const declared = await declaredGraph(ctx, projectPath, resolve(args.src ?? config.sourceDir ?? "."));
    if (!declared) return refuse(BUILD_ROOT_FAILED);
    ir = declared;
  }

  // Fold derived reachability facts (effectiveIngress, internetFacing) onto
  // instance nodes so multi-hop/launch-template joins are one node predicate (#1139).
  ir = enrichEffectiveTopology(ir);
  // Capability terms (#4375) read the graph through the lexicons' mappings.
  if (terms.some(usesCapability)) {
    const refused = await bindCapabilities(ctx, projectPath, ir, terms);
    if (refused) return refuse({ code: "query-invalid", ...refused });
  }
  // Resolve `kind:` terms against what is actually in this graph, before any
  // node is tested against them.
  resolveKindTerms(terms, ir.nodes);
  const nodeById = new Map(ir.nodes.map((n) => [n.id, n]));
  const matches = ir.nodes.filter((n) => terms.every((t) => matchTerm(n, t, ir, nodeById)));
  // Query-scoped drift (#1268): the matched rows, and only the matched rows,
  // checked against the observation the primary answer did NOT use. Scoping
  // both sides of diffLive() to the matched ids is what keeps a query-scoped-
  // out resource from reading as `missing` or `unobserved` — it was never
  // asked about, which is a third thing from both.
  let drift: LiveDiffResult | undefined;
  if (checkObservations && declaredForDrift && primaryObservations) {
    const declaredIds = new Set(declaredForDrift.nodes.map((n) => n.id));
    const matchedIds = new Set(matches.map((n) => n.id));
    const nowObservations = args.checkLive ? checkObservations : primaryObservations;
    const thenObservations = args.checkLive ? primaryObservations : checkObservations;
    drift = diffLive({
      declared: new Set([...matchedIds].filter((id) => declaredIds.has(id))),
      observedNow: pickResources(mergeResources(nowObservations), matchedIds),
      observedThen: pickResources(mergeResources(thenObservations), matchedIds),
      unobserved: pickResources(collectUnobserved(nowObservations), matchedIds),
    });
  }
  const driftAgainst: "live" | "snapshot" = args.checkLive ? "live" : "snapshot";
  // Machine-readable answer (#4359, #4367): the rows, their paths, and every
  // footer the text prints as prose, as one document for a caller that draws
  // it (behold#913). Same exit codes as the text path.
  if (args.json) {
    const recorded =
      source.kind === "live" && !matches.some((n) => n.physicalId) && args.env
        ? (await hasSnapshot(String(args.env))) ? "yes" : undefined
        : undefined;
    const env = args.env && source.kind !== "declared" ? String(args.env) : undefined;
    const provenanceText = provenanceLine(matches, source, recorded, liveFailures, [...derivedUsed(terms, matches, ir), ...capabilitiesUsed(terms)]).replace(/^— /, "");
    const capNotes = capabilityNotes(terms, ir, source);
    const driftJson = drift
      ? searchDriftJson(drift, matches.length, driftAgainst, snapshotDepth)
      : driftUnavailable !== undefined
        ? { against: driftAgainst, unavailable: driftUnavailable }
        : undefined;
    // With --count-by (#4360) the object carries the groups and the total in
    // place of the matches, the same answer the grouped lines give, with the
    // provenance line beside it (#4367).
    const head = { ...searchHead(), ...(await workspaceIdentity(projectPath)) };
    const payload = countBy
      ? {
          ...head,
          ...countsJson(query, env ? { ...source, env } : source, countGroups(matches, countBy, hasManyTerraformRoots(ir)), countBy, liveFailures),
          provenance: provenanceText,
          ...(driftJson ? { drift: driftJson } : {}),
        }
      : {
          ...head,
          ...searchJson(query, source, matches, terms, ir, nodeById, liveFailures, {
          ...(env ? { env } : {}),
          show,
          provenance: provenanceText,
          ...(capNotes.length > 0 ? { capabilities: capNotes } : {}),
          ...(args.explain ? { explain: explainData(terms, matches, ir, nodeById) } : {}),
          ...(driftJson ? { drift: driftJson } : {}),
        }),
        };
    console.log(JSON.stringify(payload));
    for (const n of liveNotes) console.error(formatWarning({ message: n }));
    if (liveFailures.length > 0) return 1;
    return args.failOnDrift && drift && driftCountOf(drift) > 0 ? 1 : 0;
  }
  if (matches.length === 0) {
    console.log(countBy ? "(no matches) · 0 total" : "(no matches)");
    availableAttrs(terms, ir);
    if (args.explain) explain(terms, matches, ir, nodeById, query);
    for (const n of liveNotes) console.error(formatWarning({ message: n }));
    return 0;
  }
  if (countBy) {
    for (const line of formatCounts(countGroups(matches, countBy, hasManyTerraformRoots(ir)), countBy)) console.log(line);
  } else {
    for (const n of matches) {
      console.log(formatRow(n, show));
    }
  }
  const backed = source.kind === "declared" || matches.some((n) => n.physicalId);
  // Only worth asking when the live read came back empty — that is the one case
  // where a recording changes what the caller should do next.
  const recorded =
    source.kind === "live" && !matches.some((n) => n.physicalId) && args.env
      ? (await hasSnapshot(String(args.env))) ? "yes" : undefined
      : undefined;
  provenance(matches, source, recorded, liveFailures, [...derivedUsed(terms, matches, ir), ...capabilitiesUsed(terms)]);
  for (const c of capabilityNotes(terms, ir, source)) {
    if (c.notEvaluated.length > 0) console.log(`— ${c.name} does not evaluate: ${c.notEvaluated.join("; ")}`);
  }
  // Qualifies the provenance line, so it sits with it: one line per distinct
  // note for the whole run, not one per stack, and after the rows (#1265).
  for (const n of liveNotes) console.error(formatWarning({ message: n }));
  if (drift) {
    const driftCount = renderDrift(drift, matches.length, driftAgainst, snapshotDepth);
    if (args.failOnDrift && driftCount > 0) driftFailure = true;
  }
  ambientHint(matches, ambientKinds, args.ambient === true, replayAmbient);
  // Both point at `--show`, which a grouped count does not print (#4360).
  if (!countBy) {
    showMiss(matches, show);
    regionSpread(terms, matches, show);
  }
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


/** A search's arguments refused before anything is read, or its parsed terms and grouping. */
export type SearchArgsCheck =
  | { error: { code: SearchErrorCode; message: string; hint?: string } }
  | { terms: Term[]; countBy?: CountBy };

/**
 * Check a search's query and flags before anything is read (#4374): the
 * grammar, `--count-by`, and the flags that need or exclude each other. The
 * rules `chant search` and `chant workspace search` share, so the workspace
 * form refuses once, with the same code and message, instead of once per
 * member. `snapshot` is the snapshot asked for and the flag that asked:
 * `--snapshot`, or plain search's `--at`.
 */
export function checkSearchArgs(
  args: { countBy?: string; checkLive?: boolean; checkSnapshot?: boolean; failOnDrift?: boolean; live?: boolean; env?: string },
  query: string,
  snapshot: { ref?: string; flag: string },
): SearchArgsCheck {
  const flag = snapshot.flag;
  // `--count-by` groups the matched set (#4360). It takes any query, and no
  // query at all counts the whole graph: "which kinds does this estate hold".
  let countBy: CountBy | undefined;
  if (args.countBy !== undefined) {
    const parsed = parseCountBy(args.countBy);
    if ("error" in parsed) return { error: { code: "query-invalid", message: parsed.error, hint: parsed.hint } };
    countBy = parsed;
  }
  if (!query && !countBy) {
    return { error: { code: "query-invalid", message: "chant search needs a query: chant search \"<terms>\" [--live --env <name>]" } };
  }
  let terms: Term[];
  try {
    terms = parseQuery(query);
  } catch (err) {
    if (err instanceof QueryError) return { error: { code: "query-invalid", message: err.message, hint: err.hint } };
    throw err;
  }
  // Query-scoped drift (#1268): --check-live checks a snapshot answer against
  // a live read, --check-snapshot checks a live answer against the recorded
  // snapshot — the direction each needs is the source it does NOT already have.
  if (args.checkLive && !snapshot.ref) {
    return {
      error: {
        code: "usage-invalid",
        message: `chant search --check-live needs ${flag} <ref>`,
        hint: `answer from a snapshot and check the matched rows against a live read: ${flag} latest --check-live --env <name>`,
      },
    };
  }
  if (args.checkSnapshot && !args.live) {
    return {
      error: {
        code: "usage-invalid",
        message: "chant search --check-snapshot needs --live",
        hint: "answer live and check the matched rows against the recorded snapshot: --live --check-snapshot --env <name>",
      },
    };
  }
  if (args.failOnDrift && !args.checkLive && !args.checkSnapshot) {
    return {
      error: {
        code: "usage-invalid",
        message: "chant search --fail-on-drift needs --check-live or --check-snapshot",
        hint: "it fails the check those flags run, so it is meaningless without one",
      },
    };
  }
  if ((args.live || snapshot.ref) && !args.env) {
    const needs = snapshot.ref ? flag : "--live";
    return { error: { code: "usage-invalid", message: `chant search ${needs} needs an environment: ${needs} --env <name>` } };
  }
  if (args.live && snapshot.ref) {
    // Two different observations of the same estate, and no rule for which
    // wins. Comparing them is a real question (#1268) but it is not this one.
    return {
      error: {
        code: "usage-invalid",
        message: `chant search takes --live or ${flag}, not both`,
        hint: `--live reads the estate now; ${flag} answers from a recorded snapshot`,
      },
    };
  }
  return { terms, ...(countBy ? { countBy } : {}) };
}

/** Why a search over a project whose build root failed refuses (#4365), as the refusal prints it. */
const BUILD_ROOT_FAILED = {
  code: "build-failed",
  message: "chant search: a build root failed to render, so the graph it would answer over is incomplete",
  hint: "fix the error above; `chant graph . --format ir` reports the same one",
} as const;

/**
 * The declared graph a search answers over (#4362, #4365, #4368): discovery,
 * plus the build-root entities (a terraform root's blocks, a rendered
 * kustomize root), plus the edges the lexicons' `graphEdges` hooks add. The
 * same join and the same edges `chant graph --format ir` draws, through the
 * same helpers (`./declared-graph.ts`), so a node's id here is its id there.
 *
 * Returns undefined, having printed the build root's own errors, when a build
 * root failed to render or collided with a discovered name; the caller refuses
 * with {@link BUILD_ROOT_FAILED}. A search over the rest would answer
 * `(no matches)` for a root it never read, which is a wrong answer stated as
 * a fact.
 */
async function declaredGraph(
  ctx: CommandContext,
  projectPath: string,
  srcDir: string,
  loaded?: readonly LexiconPlugin[],
): Promise<GraphIR | undefined> {
  const discovered = await discover(srcDir);
  if (!(await mergeDeclaredBuildRoots(discovered.entities, await declaredBuildRootContributors(ctx, projectPath)))) return undefined;
  let plugins = loaded ?? ctx.plugins;
  if (plugins.length === 0) {
    try {
      plugins = await loadPlugins(await resolveProjectLexicons(projectPath));
    } catch {
      plugins = [];
    }
  }
  return withLexiconEdges(buildGraphIr(discovered.entities, projectPath), plugins, discovered.entities);
}

/**
 * Print the capability catalog (#4375): the `capabilities` document under
 * `--json`, a line per capability otherwise. It takes no query and no other
 * search flag, since it answers nothing about the estate. Shared by `chant
 * search` and `chant workspace search`, which differ only in the lexicons
 * they report on.
 */
export async function printCapabilities(
  args: { json?: boolean; live?: boolean; env?: string; snapshot?: string; at?: string; countBy?: string; explain?: boolean; show?: string },
  query: string,
  lexicons: string[],
): Promise<number> {
  const { capabilitiesDocument, capabilitiesFailure, formatCapabilities } = await import("../../workspace/capabilities-contract");
  const extra = [
    // `args.path` is "." when no query was given.
    ...(query && query !== "." ? [`the query "${query}"`] : []),
    ...(["live", "env", "snapshot", "at", "countBy", "explain", "show"] as const)
      .filter((k) => args[k] !== undefined && args[k] !== false)
      .map((k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`),
  ];
  if (extra.length > 0) {
    const error = {
      code: "usage-invalid" as const,
      message: `--capabilities prints the catalog, so it takes no query and no other search flag; it was given ${extra.join(", ")}`,
      hint: "ask with a capability instead: chant search \"cap:internet-reachable(22)\"",
    };
    console.error(formatError(error));
    if (args.json) console.log(JSON.stringify(await capabilitiesFailure(error)));
    return 1;
  }
  const doc = await capabilitiesDocument(lexicons);
  if (args.json) console.log(JSON.stringify(doc));
  else for (const line of formatCapabilities(doc)) console.log(line);
  return 0;
}

/** The capabilities a query names, in query order, for the provenance line (#4375). */
function capabilitiesUsed(terms: Term[]): string[] {
  const out: string[] = [];
  const walk = (t: Term): void => {
    if (t.negated) return;
    const call = t.kind === "cap" ? t.a : t.capability;
    const name = call !== undefined ? parseCapabilityCall(call)?.name : undefined;
    if (name && !out.includes(name)) out.push(name);
    if (t.sub) walk(t.sub);
  };
  terms.forEach(walk);
  return out;
}

/**
 * What each capability the query used could not evaluate (#4375), with a
 * count where this graph holds the thing left out: an answer computed from
 * declared references says what it skipped, so a caller knows the rows are a
 * floor, not the whole of it.
 */
function capabilityNotes(terms: Term[], ir: GraphIR, source: AnswerSource): { name: string; source: AnswerSource["kind"]; notEvaluated: string[] }[] {
  const names = capabilitiesUsed(terms);
  if (names.length === 0) return [];
  const engine = capabilityEngine(ir);
  const statements = [...engine.view.nodes.values()].filter((n) => n.label === "Statement" && n.attrs.effect === "Allow");
  const counts: Record<string, number> = {
    'Resource "*"': statements.filter((n) => n.attrs.anyResource).length,
    "IAM Condition keys": statements.filter((n) => n.attrs.condition).length,
    "resources the graph holds but can't resolve, such as an expression naming nothing declared": statements.filter((n) => n.attrs.unresolved).length,
  };
  return names.map((name) => ({
    name,
    source: source.kind,
    notEvaluated: (engine.rule(name)?.meta["not-evaluated"] ?? "")
      .split(/;|\n/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => (counts[x] ? `${x} (${counts[x]} statement${counts[x] === 1 ? "" : "s"} here)` : x)),
  }));
}

/**
 * Answer capability terms over a graph that is not this project's own (#4375):
 * `chant workspace search` composes its members' graphs and views and asks
 * here, so the rules run once over the whole of it. Given packs, the view is
 * built here; given a view, it is the one the members' own chants mapped
 * (#4378). Returns the rows
 * as `--json` carries them, or the refusal for a capability the query names
 * wrongly.
 */
export function answerOverGraph(
  ir: GraphIR,
  terms: Term[],
  query: string,
  packsOrView: CapabilityPack[] | View,
): { matches: SearchJson["matches"]; capabilities: NonNullable<SearchJson["capabilities"]> } | { error: { message: string; hint?: string } } {
  // A workspace hands over the view its members' chants mapped (#4378).
  const engine = Array.isArray(packsOrView) ? attachCapabilities(ir, packsOrView) : attachView(ir, packsOrView);
  const refused = checkCapabilityTerms(engine, terms);
  if (refused) return { error: refused };
  resolveKindTerms(terms, ir.nodes);
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const matches = ir.nodes.filter((n) => terms.every((t) => matchTerm(n, t, ir, byId)));
  const doc = searchJson(query, { kind: "declared" }, matches, terms, ir, byId);
  return { matches: doc.matches, capabilities: capabilityNotes(terms, ir, { kind: "declared" }) };
}

/** Whether a term, or the leaf under it, names a capability (#4375). */
export function usesCapability(t: Term): boolean {
  return t.kind === "cap" || t.capability !== undefined || (t.sub !== undefined && usesCapability(t.sub));
}

/**
 * Bind the graph to its lexicons' capability packs and check every capability
 * the query names (#4375): an unknown name, a set used as an edge or the
 * wrong arguments is a refusal, never an empty answer.
 */
async function bindCapabilities(
  ctx: CommandContext,
  projectPath: string,
  ir: GraphIR,
  terms: Term[],
): Promise<{ message: string; hint?: string } | undefined> {
  let plugins: readonly LexiconPlugin[] = ctx.plugins;
  if (plugins.length === 0) {
    try {
      plugins = await loadPlugins(await resolveProjectLexicons(projectPath));
    } catch {
      plugins = [];
    }
  }
  const engine = attachCapabilities(ir, plugins.map((p) => p.capabilityPack).filter((p): p is CapabilityPack => !!p));
  return checkCapabilityTerms(engine, terms);
}

/** Refuse a capability the query names that doesn't exist, a set used as an edge, or the wrong arguments. */
function checkCapabilityTerms(engine: CapabilityEngine, terms: Term[]): { message: string; hint?: string } | undefined {
  const known = [...new Set(engine.publicNames())].join(", ");
  const check = (t: Term): { message: string; hint?: string } | undefined => {
    if (t.sub) {
      const inner = check(t.sub);
      if (inner) return inner;
    }
    const call = t.kind === "cap" ? t.a : t.capability;
    if (call === undefined) return undefined;
    const parsed = parseCapabilityCall(call)!;
    if (!engine.has(parsed.name)) {
      return { message: `no capability "${parsed.name}"`, hint: `the capabilities are ${known}; chant search --capabilities describes each` };
    }
    const shape = engine.rule(parsed.name)!.vars.length === 1 ? "set" : "edge";
    if (t.capability !== undefined && shape === "set") {
      return { message: `"${parsed.name}" is a set, not an edge`, hint: `test it as a term: cap:${call}` };
    }
    try {
      engine.bind(parsed.name, parsed.args);
    } catch (err) {
      if (err instanceof CapabilityError) return { message: `cap:${call}: ${err.message}`, hint: "chant search --capabilities lists each capability's parameters" };
      throw err;
    }
    return undefined;
  };
  for (const t of terms) {
    const r = check(t);
    if (r) return r;
  }
  return undefined;
}

/** Where an answer's facts came from, for the provenance line (#1266). */
export type AnswerSource =
  | { kind: "declared" }
  | { kind: "live" }
  /** `snapshot` is the ref asked for (`latest`), `commit` the snapshot commit it named (#4374). */
  | { kind: "snapshot"; snapshot?: string; commit: string; timestamp: string };




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
function provenanceLine(
  matches: IRNode[],
  source: AnswerSource,
  recorded?: string,
  liveFailures: string[] = [],
  derived: string[] = [],
): string {
  if (source.kind === "declared") {
    // A derived fact the query relied on (#4362) was folded from declared
    // references alone, so it describes the source, not the account.
    const from = derived.length > 0 ? ` · ${derived.join(", ")} derived from declared references` : "";
    return `— declared only · no observation · physical ids unavailable${from}`;
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
    return `— live read failed (${lexicons}) · ${unobserved}/${matches.length} rows unobserved · ${rest}`;
  }
  if (bound === 0) {
    // The estate was asked for and nothing came back bound. Naming it is the
    // difference between "these do not exist" and "nobody could see them".
    // A snapshot sitting unused is the actionable half of this. Denied network,
    // agents read six declared rows as a live answer and spent their turns
    // retrying `--live` — the tool knew the estate was unreachable AND that a
    // recording of it was on disk, and said only the first half.
    if (recorded) {
      return (
        `— ${what} returned no bound resources · a snapshot of this environment is recorded — answer from it with --at latest`
    );
    }
    return (
      `— ${what} returned no bound resources · answered from the declared graph · physical ids unavailable`
    );
  }
  if (source.kind === "live") {
    return `— observed live · bound ${bound}/${matches.length}`;
  }
  // Time is the whole risk of a recorded answer, so it leads. A caller can see
  // how old this is and decide, rather than discovering staleness later.
  const taken = source.timestamp ? ` taken ${source.timestamp}` : "";
  const at = source.commit ? ` ${source.commit.slice(0, 7)}` : "";
  return `— observed from snapshot${at}${taken} · bound ${bound}/${matches.length}`;
}

/** Print {@link provenanceLine}: the text footer. */
function provenance(
  matches: IRNode[],
  source: AnswerSource,
  recorded?: string,
  liveFailures: string[] = [],
  derived: string[] = [],
): void {
  console.log(provenanceLine(matches, source, recorded, liveFailures, derived));
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
  const driftCount = driftCountOf(diff);
  const label = direction === "live" ? "a live read" : "the recorded snapshot";
  const depthNote = depth === "deep" ? " · snapshot recorded at deep depth, compared here at identity" : "";
  console.log(
    `— checked against ${label} · ${driftCount > 0 ? `${driftCount} of ${checked} matched drifted` : `no drift across ${checked} matched`}${depthNote}`,
  );
  return driftCount;
}

/** What counts as drift: the set `lifecycle diff` totals (#1268). */
function driftCountOf(diff: LiveDiffResult): number {
  return diff.missing.length + diff.orphan.length + diff.disappeared.length + diff.driftedSinceSnapshot.length;
}

/** The query-scoped drift check as `--json` carries it (#4367). See {@link SearchJson}. */
export interface SearchDriftJson {
  against: "live" | "snapshot";
  /** Matched rows checked. */
  checked?: number;
  /** Rows that drifted: missing + orphan + disappeared + drifted, as the text summary counts. */
  count?: number;
  missing?: string[];
  orphan?: string[];
  disappeared?: string[];
  drifted?: { id: string; path: string; old?: unknown; new?: unknown }[];
  newlyObserved?: string[];
  runtimeChildren?: { id: string; type: string; owner: string }[];
  unobserved?: { id: string; type?: string; reason: string; detail?: string }[];
  /** The snapshot was recorded deeper than the identity-level comparison made here. */
  depth?: ObservationDepth;
  /** --check-snapshot found no snapshot to check against: the reason, and no other field. */
  unavailable?: string;
}

function searchDriftJson(
  diff: LiveDiffResult,
  checked: number,
  against: "live" | "snapshot",
  depth?: ObservationDepth,
): SearchDriftJson {
  return {
    against,
    checked,
    count: driftCountOf(diff),
    missing: diff.missing,
    orphan: diff.orphan,
    disappeared: diff.disappeared,
    drifted: diff.driftedSinceSnapshot.flatMap((d) =>
      d.changes.map((c) => ({ id: d.name, path: c.path, old: c.oldValue, new: c.newValue })),
    ),
    newlyObserved: diff.newlyObserved,
    runtimeChildren: diff.runtimeChildren.map((r) => ({ id: r.name, type: r.type, owner: r.owner })),
    unobserved: diff.unobserved.map((u) => ({
      id: u.name,
      ...(u.type ? { type: u.type } : {}),
      reason: u.reason,
      ...(u.detail ? { detail: u.detail } : {}),
    })),
    ...(depth ? { depth } : {}),
  };
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
  const data = explainData(terms, matches, ir, byId);
  const kindLabel = data.universe.kinds.length > 0 ? data.universe.kinds.join("/") : "nodes";
  console.log(`— ${data.universe.matched} of ${data.universe.of} ${kindLabel} matched  (query: ${query})`);
  // Inclusion evidence: for a derived fact a CLI can't easily re-verify
  // (internetFacing, resolved across the default VPC's routing), name WHY each
  // match qualifies, so the agent trusts the result instead of dropping it.
  for (const e of data.evidence) console.log(`  ✓ ${bareId(e.id)} ${e.attr} via ${e.via}`);
  // The chain each match was reached by (#4359), so a caller can quote the
  // path instead of re-deriving it with one search per hop.
  for (const n of matches) {
    for (const p of matchPaths(n, terms, ir, byId)) {
      // A capability's path (#4375) turns as the rule does, so each hop says which way it went.
      if (p.term.kind === "cap" || p.term.capability !== undefined) {
        // A set a node is in by its own attributes (stores-data) has no path to print.
        if (p.hops.length === 0 && !p.because) continue;
        console.log(`  path ${bareId(n.id)} ${termText({ ...p.term, negated: false })}: ${formatHops(p.hops, n.id) || "(the node itself)"}`);
        for (const b of p.because ?? []) {
          console.log(`    ${b.capability} ${bareId(b.id)}: ${formatHops(b.hops, b.id) || "(an attribute of the node)"}`);
        }
      } else console.log(`  path ${formatPath(p.hops, p.term.dir!)}`);
    }
  }
  for (const m of data.nearMisses) {
    console.log(`  · excluded ${bareId(m.id)} — fails ${m.term ? describeTerm(m.term) : "(query)"}`);
  }
  if (data.moreExcluded > 0) console.log(`  · …and ${data.moreExcluded} more excluded`);
}

/** How many near-misses `--explain` names before summarising the rest. */
const NEAR_MISS_LIMIT = 8;

/**
 * The facts behind the `--explain` footer, shared by the text and `--json`
 * (#4367). The universe is every node of the matched kinds (every node when
 * nothing matched); a near-miss is a node of that universe the query
 * excluded, with the first term it fails.
 */
function explainData(
  terms: Term[],
  matches: IRNode[],
  ir: GraphIR,
  byId: Map<string, IRNode>,
): {
  universe: { matched: number; of: number; kinds: string[] };
  evidence: { id: string; attr: string; via: string }[];
  nearMisses: { id: string; term?: Term }[];
  moreExcluded: number;
} {
  // Counted against a terraform block's type, not `Terraform::Resource` (#4366):
  // "2 of 2 aws_instance", not "2 of 185 Terraform::Resource".
  const kinds = new Set(matches.map(displayKind).filter((k): k is string => !!k));
  const universe = kinds.size > 0 ? ir.nodes.filter((n) => kinds.has(displayKind(n) ?? "")) : ir.nodes;
  const matched = new Set(matches.map((n) => n.id));
  const excluded = universe.filter((n) => !matched.has(n.id));
  const evidence: { id: string; attr: string; via: string }[] = [];
  for (const t of terms) {
    if (t.kind !== "attr") continue;
    for (const n of matches) {
      const via = (n.attrs as Record<string, unknown> | undefined)?.[`${t.a}Via`];
      if (typeof via === "string") evidence.push({ id: n.id, attr: t.a, via });
    }
  }
  const shown = excluded.slice(0, NEAR_MISS_LIMIT);
  return {
    universe: { matched: matches.length, of: universe.length, kinds: [...kinds] },
    evidence,
    nearMisses: shown.map((n) => ({ id: n.id, term: terms.find((t) => !matchTerm(n, t, ir, byId)) })),
    moreExcluded: excluded.length - shown.length,
  };
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
  const of = ir.nodes.filter((n) => matchTerm(n, { ...kindTerm, negated: false }));
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
  if (x.kind === "cap") return `cap:${x.a}`;
  return x.kind === "kind" ? `kind:${x.a}` : x.kind === "attr" ? `attr:${x.a}${x.b !== undefined ? "=" + x.b : ""}`
    : x.kind === "tag" ? `tag:${x.a}${x.b !== undefined ? "=" + x.b : ""}` : `"${x.a}"`;
}

/**
 * `chant search --json` (#4359, #4367): the whole answer as one document on
 * stdout, read by behold (behold#913). Warnings and errors still go to stderr;
 * the exit code is the text path's. It is the `search` document of the read
 * contract (#4374, `workspace/search.schema.json`): every document opens with
 * `$schema`, `contract` and `chant`, then `workspace` when the project belongs
 * to one, and `at: null`, since plain search reads the working tree.
 *
 *   {
 *     "$schema": "https://intentius.io/chant/schemas/workspace/search/v1/search.schema.json",
 *     "contract": 1, "chant": "0.124.46", "workspace"?: { "name", "root" }, "at": null,
 *     "query": "kind:aws_instance ->*kind:aws_vpc",
 *     "source": { "kind": "declared" | "live" | "snapshot", "env"?, "snapshot"?, "commit"?, "timestamp"? },
 *     "matches": [
 *       { "id": "east::web", "displayId": "web", "kind": "Terraform::Resource", "physicalId"?: "i-1",
 *         "unobserved"?: "read-failed", "show"?: { "InstanceType": "t3.micro" },
 *         "paths": [ { "term": "->*kind:aws_vpc", "dir": "out",
 *                      "hops": [ { "from": "web", "fromAttr": "subnet_id", "to": "a", "toAttr": "id" },
 *                                { "from": "a", "fromAttr": "vpc_id", "to": "main", "toAttr": "id" } ] } ] }
 *     ],
 *     "provenance": "observed live · bound 2/2",
 *     "liveFailures"?: ["aws: ..."],
 *     "explain"?: { "universe": { "matched": 2, "of": 6, "kinds": ["aws_instance"] },
 *                   "evidence": [ { "id": "web", "attr": "internetFacing", "via": "..." } ],
 *                   "nearMisses": [ { "id": "db", "fails": "attr:internetFacing=true" } ],
 *                   "moreExcluded": 0 },
 *     "drift"?: { "against": "live" | "snapshot", ... see SearchDriftJson }
 *   }
 *
 * A refused query or invocation prints the head, `query` and
 * `error: { code, message, hint? }` instead, and exits 1. The code is from the
 * read contract's closed list (`SEARCH_ERROR_CODES`).
 *
 * `kind` is the IR kind, so a Terraform block's is `Terraform::Resource`;
 * `kind:aws_instance` matches it by its resource type (#4366).
 *
 * `id` is the graph's full id, stack-qualified (`stack::name`) where the graph
 * qualifies it; `displayId` is the bare name the text row prints. `hops` is in
 * walk order from the match; each hop keeps the edge's own direction (see
 * {@link PathHop}). `paths` is empty when the query has no positive edge
 * term. `show` is present when `--show` was given, holding the requested
 * attributes a row carries, under the name the graph spells them with.
 * `explain` is present with `--explain`; `drift` with `--check-live` or
 * `--check-snapshot`.
 */
export interface SearchJson {
  query: string;
  source: AnswerSource & { env?: string };
  matches: {
    id: string;
    displayId: string;
    kind?: string;
    physicalId?: string;
    unobserved?: string;
    show?: Record<string, unknown>;
    paths: { term: string; dir: "out" | "in"; hops: PathHop[]; because?: { capability: string; id: string; hops: PathHop[] }[] }[];
  }[];
  provenance?: string;
  liveFailures?: string[];
  explain?: {
    universe: { matched: number; of: number; kinds: string[] };
    evidence: { id: string; attr: string; via: string }[];
    nearMisses: { id: string; fails?: string }[];
    moreExcluded: number;
  };
  drift?: SearchDriftJson;
  /**
   * Present when the query names a capability (#4375): each one, the
   * observation its facts were derived from, and what it does not evaluate.
   */
  capabilities?: { name: string; source: AnswerSource["kind"]; notEvaluated: string[] }[];
}

/**
 * A refusal under `--json` (#4367): the same message and hint stderr carries,
 * with its code from the read contract's closed list (#4374).
 */
export type SearchErrorJson = SearchFailure;

function searchErrorJson(query: string, error: { code: SearchErrorCode; message: string; hint?: string }): SearchErrorJson {
  return { ...searchHead(), query, error: { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) } };
}

/** The head of every `search` document (#4374): the contract, its schema, and the chant that wrote it. */
function searchHead(): SearchHead {
  return { $schema: SEARCH_OUTPUT_SCHEMA_ID, contract: SEARCH_CONTRACT_VERSION, chant: readChantPackageVersion() };
}

/**
 * The workspace a project belongs to, when it belongs to one (#4374, ws-016):
 * its declared name and its root relative to the git root, with `at: null`,
 * since plain search reads the working tree. Outside a workspace, or when its
 * declaration can't be read, only `at`.
 */
async function workspaceIdentity(cwd: string): Promise<{ workspace?: { name: string; root: string }; at: null }> {
  try {
    const [{ locateWorkspace }, { readDeclaration }] = await Promise.all([import("../../workspace/which-chant"), import("../../workspace/declaration")]);
    const located = locateWorkspace(cwd);
    return { workspace: { name: readDeclaration(located.tree, "").name, root: located.root }, at: null };
  } catch {
    return { at: null };
  }
}

function searchJson(
  query: string,
  source: AnswerSource,
  matches: IRNode[],
  terms: Term[],
  ir: GraphIR,
  byId: Map<string, IRNode>,
  liveFailures: string[] = [],
  extra: {
    env?: string;
    show?: string[];
    provenance?: string;
    capabilities?: SearchJson["capabilities"];
    explain?: ReturnType<typeof explainData>;
    drift?: SearchDriftJson;
  } = {},
): SearchJson {
  const show = extra.show ?? [];
  return {
    query,
    source: extra.env ? { ...source, env: extra.env } : source,
    matches: matches.map((n) => {
      const attrs = (n.attrs ?? {}) as Record<string, unknown>;
      const physical = (n as { physicalId?: unknown }).physicalId ?? attrs["physicalId"] ?? attrs["InstanceId"] ?? attrs["Id"];
      return {
        id: n.id,
        displayId: bareId(n.id),
        ...(n.kind ? { kind: n.kind } : {}),
        ...(physical != null && typeof physical !== "object" ? { physicalId: String(physical) } : {}),
        ...(typeof attrs["_unobserved"] === "string" ? { unobserved: attrs["_unobserved"] } : {}),
        ...(show.length > 0 ? { show: Object.fromEntries(showValues(attrs, show)) } : {}),
        paths: matchPaths(n, terms, ir, byId).map((p) => ({
          term: termText({ ...p.term, negated: false }),
          dir: p.term.dir ?? ("out" as const),
          hops: p.hops,
          ...(p.because ? { because: p.because } : {}),
        })),
      };
    }),
    ...(extra.provenance !== undefined ? { provenance: extra.provenance } : {}),
    ...(extra.capabilities ? { capabilities: extra.capabilities } : {}),
    ...(liveFailures.length > 0 ? { liveFailures } : {}),
    ...(extra.explain
      ? {
          explain: {
            universe: extra.explain.universe,
            evidence: extra.explain.evidence,
            nearMisses: extra.explain.nearMisses.map((m) => ({ id: m.id, ...(m.term ? { fails: termText(m.term) } : {}) })),
            moreExcluded: extra.explain.moreExcluded,
          },
        }
      : {}),
    ...(extra.drift ? { drift: extra.drift } : {}),
  };
}

/** A term as the query grammar spells it, `!` and ASCII arrows included (#4367). */
function termText(t: Term): string {
  if (t.negated) return `!${termText({ ...t, negated: false })}`;
  if (t.kind === "edge") return `${edgeOperator(t, { out: "->", in: "<-" })}${t.sub ? leafText(t.sub) : ""}`;
  return leafText(t);
}

export interface Term {
  kind: "word" | "kind" | "tag" | "attr" | "edge" | "cap";
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
   * For edge terms (#4375): walk this edge capability (`reaches`,
   * `grants(s3:GetObject)`) instead of the graph's own edges. A `cap:` leaf
   * keeps its call in `a`.
   */
  capability?: string;
  /**
   * For kind terms: the kinds this term actually means, resolved against the
   * graph (see {@link resolveKindTerms}). Absent when nothing resolved it, in
   * which case the substring rule applies unchanged.
   */
  kinds?: Set<string>;
  /**
   * For kind terms (#4366): the terraform resource types this term means,
   * resolved against the graph. A terraform resource matches the term when its
   * type is in here, whatever `kinds` says.
   */
  tfTypes?: Set<string>;
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
 *
 * A terraform resource is `Terraform::Resource` whatever it is, so the term is
 * also read against each resource's type (#4366), with the same boundary rule
 * on `_`: `kind:aws_iam_role` means that type exactly and never
 * `aws_iam_role_policy`, and a term ending in `_` (`kind:aws_iam_`) or a bare
 * provider name (`kind:aws`) means every type it begins. A data source's type
 * keeps its `data.` prefix (`kind:data.aws_ami`), the same type `--count-by kind`
 * groups it under, so `kind:aws_ami` is not a data source. A term that names a
 * type turns off the substring fallback for the IR kind, so `kind:aws_instance`
 * is the instances and nothing found by accident.
 */
export function resolveKindTerms(terms: Term[], nodes: IRNode[]): void {
  const present = [...new Set(nodes.map((n) => n.kind).filter((k): k is string => !!k))];
  const tfPresent = [...new Set(nodes.map(terraformType).filter((k): k is string => !!k))];
  const walk = (t: Term): void => {
    if (t.sub) walk(t.sub);
    if (t.kind !== "kind") return;
    const types = resolveTerraformTypes(t.a, tfPresent);
    if (types.length > 0) t.tfTypes = new Set(types);
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

/** The terraform resource types a `kind:` term names, by the rule in {@link resolveKindTerms}. */
function resolveTerraformTypes(term: string, present: string[]): string[] {
  const want = term.toLowerCase();
  if (want.length === 0 || want.includes("::")) return [];
  const exact = present.filter((p) => p === want);
  if (exact.length > 0) return exact;
  const prefix = want.endsWith("_") || want.endsWith(".") ? want : /[_.]/.test(want) ? undefined : `${want}_`;
  return prefix ? present.filter((p) => p.startsWith(prefix)) : [];
}

/** What a row and `--explain` call a node's kind: a terraform block's type (#4366), else its IR kind. Same as `--count-by kind`. */
function displayKind(n: IRNode): string | undefined {
  return terraformType(n) ?? n.kind;
}

function parseLeaf(tok: string): Term {
  const cap = /^cap:(.*)$/i.exec(tok);
  if (cap) {
    if (!parseCapabilityCall(cap[1])) {
      throw new QueryError(
        `"${tok}" is not a capability term`,
        "name a capability, with arguments in parentheses when it takes any: cap:internet-reachable, cap:open-ingress(22); chant search --capabilities lists them",
      );
    }
    return { kind: "cap", a: cap[1] };
  }
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
    // Split on commas outside parentheses, so `[cap=open-ingress(22,tcp)]` is one part.
    const parts = close < 0 ? [""] : (rest.slice(1, close).match(/(?:[^,(]|\([^)]*\))+/g) ?? [""]).map((p) => p.trim());
    for (const part of parts) {
      const c = /^cap=(.+)$/.exec(part);
      if (c && parseCapabilityCall(c[1])) {
        term.capability = c[1];
        continue;
      }
      const q = /^(via|to)=(.+)$/.exec(part);
      if (!q) {
        throw new QueryError(
          `"${tok}" has an edge qualifier this grammar cannot read`,
          `qualify an edge by attribute with [via=<consumer attr>] or [to=<producer attr>], e.g. <-[via=vpc_id]kind:aws_subnet or ->[via=subnet_id,to=id], or walk a capability with [cap=<name>], e.g. ->[cap=reaches]cap:stores-data`,
        );
      }
      if (q[1] === "via") term.viaAttr = q[2];
      else term.toAttr = q[2];
    }
    rest = rest.slice(close + 1);
  }
  if (rest.trim() === "") {
    if (term.viaAttr === undefined && term.toAttr === undefined && term.capability === undefined) {
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

/**
 * Attributes a bare word does not search, by lexicon (#4368). A terraform
 * node's `source` is the whole `.tf` file its block came from (the lint
 * checks need the raw text), so a bare `aws_security_group` matched every
 * node declared in a file that mentions one: 21 nodes on behold's example
 * estate, where three are security groups. The block itself is still
 * searched, through `address` and `body`, and `attr:source=<text>` still
 * reads the file when that is what the caller means.
 */
const BARE_WORD_SKIPS: Record<string, ReadonlySet<string>> = {
  terraform: new Set(["source"]),
};

function matchTerm(n: IRNode, t: Term, ir?: GraphIR, byId?: Map<string, IRNode>): boolean {
  if (t.negated) return !matchTerm(n, { ...t, negated: false }, ir, byId);
  const attrs = n.attrs ?? {};
  if (t.kind === "edge") {
    if (!ir || !byId) return false;
    // Depth and attribute qualifiers (#4359) go through the path search. A
    // plain one-hop term keeps the original code below, unchanged.
    if (t.depth || t.viaAttr !== undefined || t.toAttr !== undefined || t.capability !== undefined) return findPath(n, t, ir, byId) !== null;
    if (!t.sub) return false;
    // A node matches if it has an edge (out or in) to a node satisfying `sub`.
    const edges = ir.edges ?? [];
    const neighbors = edges
      .filter((e) => (t.dir === "out" ? e.from === n.id : e.to === n.id))
      .map((e) => byId.get(t.dir === "out" ? e.to : e.from))
      .filter((x): x is IRNode => !!x);
    return neighbors.some((m) => matchTerm(m, t.sub!, ir, byId));
  }
  if (t.kind === "cap") return !!ir && capabilityEvidence(n, t, ir) !== undefined;
  if (t.kind === "kind") {
    // Resolved kinds when the term lined up with `::` boundaries; the
    // documented substring otherwise. A term that named a terraform type
    // (#4366) matches resources of that type as well, and drops the substring.
    if (t.tfTypes?.has(terraformType(n) ?? "")) return true;
    if (t.kinds) return t.kinds.has(n.kind ?? "");
    if (t.tfTypes) return false;
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
  // bare word: substring over id, kind, and all attr values, less the ones
  // that hold text about other nodes (see BARE_WORD_SKIPS).
  const skip = BARE_WORD_SKIPS[n.lexicon];
  const values = Object.entries(attrs)
    .filter(([k]) => !skip?.has(k))
    .map(([, v]) => attrString(v));
  const hay = [n.id, n.kind, ...values].join(" ").toLowerCase();
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
  /**
   * On a capability's path (#4375): the name the capability rules give this
   * edge (`subnet`, `statement`, `resource`). Its `from` may be a node inside
   * another (a policy statement, `<holder>#policy[0].Statement[1]`).
   */
  edge?: string;
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
  // A capability edge (#4375) stands for the hops that proved it.
  const steps = (id: string): { far: string; hops: PathHop[] }[] => {
    if (t.capability !== undefined) return capabilitySteps(id, t.capability, out, ir);
    return (((out ? idx.out.get(id) : idx.in.get(id)) ?? [])
      .filter((e) => (t.viaAttr === undefined || sameName(e.viaAttr, t.viaAttr)) && (t.toAttr === undefined || sameName(e.toAttr, t.toAttr)))
      .map((e) => ({
        far: out ? e.to : e.from,
        hops: [{ from: e.from, ...(e.viaAttr ? { fromAttr: e.viaAttr } : {}), to: e.to, ...(e.toAttr ? { toAttr: e.toAttr } : {}) }],
      })));
  };
  const seen = new Set<string>([`${n.id}|0`]);
  let frontier: State[] = [{ id: n.id, depth: 0, hops: [] }];
  while (frontier.length > 0) {
    const next: State[] = [];
    for (const s of frontier) {
      if (s.depth >= max) continue;
      for (const step of steps(s.id)) {
        const farId = step.far;
        const far = byId.get(farId);
        if (!far) continue;
        const depth = s.depth + 1;
        const hops = [...s.hops, ...step.hops];
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
    ...(t.capability !== undefined ? [`cap=${t.capability}`] : []),
  ];
  return `${arrow}${depth}${quals.length > 0 ? `[${quals.join(",")}]` : ""}`;
}

/** Each positive edge term's path to `n`, in query order (#4359). */
function matchPaths(n: IRNode, terms: Term[], ir: GraphIR, byId: Map<string, IRNode>): MatchPath[] {
  const out: MatchPath[] = [];
  for (const t of terms) {
    if (t.negated) continue;
    if (t.kind === "cap") {
      const ev = capabilityEvidence(n, t, ir);
      if (ev) out.push({ term: t, hops: ev.hops.map(pathHop), because: becauseOf(ev) });
      continue;
    }
    if (t.kind !== "edge") continue;
    const hops = findPath(n, t, ir, byId);
    if (hops) out.push({ term: t, hops });
  }
  return out;
}

/** A term's path to a match: one per positive edge or `cap:` term. */
interface MatchPath {
  term: Term;
  hops: PathHop[];
  /** For a `cap:` term (#4375): the node sets the match relied on, each with its own path. */
  because?: { capability: string; id: string; hops: PathHop[] }[];
}

/**
 * The evidence for a `cap:` term on a node (#4375): its path when the node
 * is in the set, or the source of an edge capability, else undefined. A
 * capability or argument the catalog can't take throws a CapabilityError,
 * which `runSearch` turns into a refusal before any node is tested.
 */
function capabilityEvidence(n: IRNode, t: Term, ir: GraphIR): Evidence | undefined {
  const call = parseCapabilityCall(t.a);
  if (!call) return undefined;
  const engine = capabilityEngine(ir);
  const args = engine.bind(call.name, call.args);
  if (engine.rule(call.name)!.vars.length === 1) return engine.set(call.name, args).get(n.id);
  const targets = engine.relation(call.name, args).out.get(n.id);
  return targets ? targets.values().next().value : undefined;
}

/** One step along an edge capability from `id` (#4375), each with the hops that proved it, in walk order. */
function capabilitySteps(id: string, call: string, out: boolean, ir: GraphIR): { far: string; hops: PathHop[] }[] {
  const parsed = parseCapabilityCall(call);
  if (!parsed) return [];
  const engine = capabilityEngine(ir);
  const rel = engine.relation(parsed.name, engine.bind(parsed.name, parsed.args));
  const m = (out ? rel.out : rel.in).get(id);
  if (!m) return [];
  return [...m].map(([far, ev]) => ({ far, hops: (out ? ev.hops : [...ev.hops].reverse()).map(pathHop) }));
}

function pathHop(h: { from: string; fromAttr?: string; to: string; toAttr?: string; edge: string }): PathHop {
  return { from: h.from, ...(h.fromAttr ? { fromAttr: h.fromAttr } : {}), to: h.to, ...(h.toAttr ? { toAttr: h.toAttr } : {}), edge: h.edge };
}

function becauseOf(ev: Evidence): MatchPath["because"] {
  const out: NonNullable<MatchPath["because"]> = [];
  const walk = (e: Evidence): void => {
    for (const b of e.because) {
      out.push({ capability: b.capability, id: b.id, hops: b.evidence.hops.map(pathHop) });
      walk(b.evidence);
    }
  };
  walk(ev);
  return out.length > 0 ? out : undefined;
}

/**
 * A capability's path as one line (#4375), in #4359's hop format, read from
 * `start`: each hop is `consumer.via -> producer.attr` when the walk follows
 * the reference, `producer.attr <- consumer.via` when it goes against it. A
 * hop with no IR attribute names the capability edge instead (`-statement->`).
 */
function formatHops(hops: PathHop[], start: string): string {
  const end = (id: string, attr?: string): string => (attr ? `${bareId(id)}.${attr}` : bareId(id));
  let at = start;
  return hops
    .map((h) => {
      const forward = h.from === at || h.to !== at;
      at = forward ? h.to : h.from;
      return forward
        ? `${end(h.from, h.fromAttr)} -> ${end(h.to, h.toAttr)}`
        : `${end(h.to, h.toAttr)} <- ${end(h.from, h.fromAttr)}`;
    })
    .join("; ");
}

function formatRow(n: IRNode, show: string[]): string {
  const attrs = (n.attrs ?? {}) as Record<string, unknown>;
  // Display the bare logical id, not the `${stack}::` qualification (#1162).
  const displayId = n.id.includes("::") ? n.id.slice(n.id.lastIndexOf("::") + 2) : n.id;
  // A terraform resource shows its type (#4366); its IR kind is `Terraform::Resource` for all of them.
  const parts: string[] = [displayId, displayKind(n) ?? ""];
  // Prefer the node-level live physicalId (set by the overlay), then attrs;
  // skip source-mode AttrRef placeholders (objects).
  const physical = (n as { physicalId?: unknown }).physicalId ?? attrs["physicalId"] ?? attrs["InstanceId"] ?? attrs["Id"];
  if (physical != null && typeof physical !== "object") parts.push(String(physical));
  // A row nobody could read says so where its physical id would go (#1263). A
  // blank there reads as "declared, not provisioned", which the read never
  // established; the reason is the tri-state's (#1089).
  else if (typeof attrs["_unobserved"] === "string") parts.push(`(unobserved: ${attrs["_unobserved"]})`);
  for (const [actual, v] of showValues(attrs, show)) {
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

/**
 * The `--show` columns a row carries, as `[name as the graph spells it, value]`,
 * in the order asked. Shared by the text row and `--json` (#4367).
 */
function showValues(attrs: Record<string, unknown>, show: string[]): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const key of show) {
    // Match the name case-insensitively, and report what was actually found.
    // AWS attribute names are PascalCase and chant's derived ones are not, so a
    // caller mixing them is normal: `--show region` and `--show Region` are the
    // same request, and one of them silently printed nothing. Seven of the
    // `--show` names in one benchmark run missed on case alone.
    const actual = key in attrs ? key : Object.keys(attrs).find((k) => k.toLowerCase() === key.toLowerCase());
    const v = actual == null ? undefined : attrs[actual];
    if (v == null) continue;
    out.push([actual!, v]);
  }
  return out;
}

/** Internals exposed for unit tests. */
export const __searchInternals = { parseQuery, matchTerm, findPath, formatPath, searchJson, searchErrorJson, explainData, termText, formatRow, explain, describeTerm, derivedSurface, availableAttrs, ambientHint, regionSpread, showMiss, provenance, provenanceLine, renderDrift, searchDriftJson, mergeResources, pickResources };
