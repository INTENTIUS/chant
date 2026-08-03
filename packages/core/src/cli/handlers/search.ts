import { resolve } from "node:path";
import { build } from "../../build";
import { buildGraphIr, buildLiveGraphIr, sourceOverlayGraphs, type GraphIR, type IRNode, type IREdge } from "../../graph-ir";
import { buildDeclaredPerStack } from "../../graph-declared";
import { enrichEffectiveTopology } from "../../graph-effective";
import { reconstructEdges, mergeCatalogs, type ReferenceCatalog } from "../../graph-refs";
import { discover } from "../../discovery/index";

import { observeResources } from "../../lifecycle/observe";
import { replaySnapshots, hasSnapshot } from "../../lifecycle/replay";
import type { LiveObservation } from "../../graph-ir";
import { loadChantConfig } from "../../config";
import { loadPlugins, resolveProjectLexicons } from "../plugins";
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

  const projectPath = resolve(".");
  const { config } = await loadChantConfig(projectPath);

  let ir: GraphIR;
  let source: AnswerSource = { kind: "declared" };
  // Kinds that can exist in the account without being declared (#1278). Known
  // without a scan, so it costs nothing to mention.
  let ambientKinds: string[] = [];
  // Set only on a replay: whether the recording itself holds ambient resources.
  let replayAmbient: { recordedAmbient: boolean } | undefined;
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
    if (config.environments && !config.environments.includes(environment)) {
      console.error(formatError({ message: `Unknown environment "${environment}"` }));
      return 1;
    }
    const plugins = ctx.plugins.length > 0 ? ctx.plugins : await loadPlugins(await resolveProjectLexicons(projectPath));
    const buildResult = await build(resolve(args.src ?? config.sourceDir ?? "."), plugins.map((p) => p.serializer));
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
    } else {
      const observed = await observeResources(environment, observing, buildResult, {
        owned: true,
        stacks,
        ambient: args.ambient === true,
      });
      for (const e of observed.errors) console.error(formatWarning({ message: e }));
      observations = observed.observations;
      source = { kind: "live" };
    }
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
    ir = sourceOverlayGraphs(declared, live);
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
  if (matches.length === 0) {
    console.log("(no matches)");
    availableAttrs(terms, ir);
    if (args.explain) explain(terms, matches, ir, nodeById, query);
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
  provenance(matches, source, recorded);
  ambientHint(matches, ambientKinds, args.ambient === true, replayAmbient);
  showMiss(matches, show);
  regionSpread(terms, matches, show);
  derivedSurface(terms, matches, ir, backed);
  if (args.explain) explain(terms, matches, ir, nodeById, query);
  return 0;
}


/** Where an answer's facts came from, for the provenance line (#1266). */
type AnswerSource =
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
function provenance(matches: IRNode[], source: AnswerSource, recorded?: string): void {
  if (source.kind === "declared") {
    console.log("— declared only · no observation · physical ids unavailable");
    return;
  }
  const bound = matches.filter((n) => n.physicalId).length;
  const what = source.kind === "live" ? "live read" : "snapshot";
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
  for (const n of matches) {
    for (const [kind, names] of Object.entries(derived)) {
      if (!n.kind?.includes(kind)) continue;
      for (const name of names) if (!used.has(name)) unused.add(name);
    }
  }
  if (unused.size === 0) return;
  console.log(`— also derived for these resources: ${[...unused].sort().join(", ")}`);
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
  const leaf = (x: Term): string =>
    x.kind === "kind" ? `kind:${x.a}` : x.kind === "attr" ? `attr:${x.a}${x.b !== undefined ? "=" + x.b : ""}`
      : x.kind === "tag" ? `tag:${x.a}${x.b !== undefined ? "=" + x.b : ""}` : `"${x.a}"`;
  if (t.kind === "edge" && t.sub) return `${t.dir === "out" ? "→" : "←"}${leaf(t.sub)} (no such edge)`;
  return leaf(t);
}

interface Term {
  kind: "word" | "kind" | "tag" | "attr" | "edge";
  /** `!term` — the node must NOT satisfy this (#1280). */
  negated?: boolean;
  a: string;
  b?: string;
  /** For edge terms: the direction and the sub-predicate matched at the far end. */
  dir?: "out" | "in";
  sub?: Term;
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
    const term = tok.startsWith("->")
      ? { kind: "edge" as const, a: "", dir: "out" as const, sub: parseLeaf(tok.slice(2)) }
      : tok.startsWith("<-")
        ? { kind: "edge" as const, a: "", dir: "in" as const, sub: parseLeaf(tok.slice(2)) }
        : parseLeaf(tok);
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
    if (!ir || !byId || !t.sub) return false;
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

function formatRow(n: IRNode, show: string[]): string {
  const attrs = (n.attrs ?? {}) as Record<string, unknown>;
  // Display the bare logical id, not the `${stack}::` qualification (#1162).
  const displayId = n.id.includes("::") ? n.id.slice(n.id.lastIndexOf("::") + 2) : n.id;
  const parts: string[] = [displayId, n.kind ?? ""];
  // Prefer the node-level live physicalId (set by the overlay), then attrs;
  // skip source-mode AttrRef placeholders (objects).
  const physical = (n as { physicalId?: unknown }).physicalId ?? attrs["physicalId"] ?? attrs["InstanceId"] ?? attrs["Id"];
  if (physical != null && typeof physical !== "object") parts.push(String(physical));
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
export const __searchInternals = { parseQuery, matchTerm, formatRow, explain, describeTerm, derivedSurface, availableAttrs, ambientHint, regionSpread, showMiss };
