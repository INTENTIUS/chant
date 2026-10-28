/**
 * `@intentius/chant/ci-estate` (#4612): the estate page, overdue drift
 * checks and delivery metrics, shared by the CI products built on chant
 * (terragucci, plywood, sql-yodeler).
 *
 * Everything is read from the workspace ledger through the read contract's
 * tables (`runs`, `gates`, `applies`, `pr_envs`; ./lifecycle/query.ts), so
 * a Terraform member and a Pulumi member come out of the same code:
 *
 * - {@link ledgerOverdue}: each member whose scheduled drift check missed
 *   its window, by chant's two-fires rule, in the product's words.
 * - {@link buildDelivery}: the four DORA metrics, written as `dora.json` in
 *   terragucci's shape, and {@link deliveryGauges} for OTLP
 *   ({@link sendOtlpGauges}, ./otlp-metrics.ts).
 * - {@link buildEstate} and {@link renderEstateHtml}: `estate.json` and
 *   `estate.html`, a section per member, with room for a product's own
 *   sections.
 * - {@link writeEstate}: all three files to the report store (`ci.reportUrl`,
 *   ./pr-report-url.ts, #4554), and the gauges when an endpoint is set.
 *
 * A product feature-detects this entry until the chant release that carries
 * {@link CI_ESTATE_FLOOR} is its floor: `buildLedgerEstate` present means the
 * rest is too. Before it, the product keeps its own estate code.
 */
import { CHANT_WORDS, type CiProductWords } from "./ci-product-words";
import type { QueryLoad } from "./lifecycle/query";
import type { ReportPut } from "./pr-report-url";
import { sendOtlpGauges, type OtlpGaugesSent } from "./otlp-metrics";
import type { OtlpFetch } from "./otlp";
import { buildDelivery, deliveryGauges, type Dora } from "./ci-estate/delivery";
import { ledgerOverdue, type DriftSchedule, type LedgerOverdue } from "./ci-estate/overdue";
import { buildEstate, ESTATE_FILES, renderEstateHtml, type Estate, type EstateSections } from "./ci-estate/page";
import { estateRows, type EstateRowOptions, type EstateRows, type EstateTables } from "./ci-estate/rows";

/** The first chant with `@intentius/chant/ci-estate` (#4612). */
export const CI_ESTATE_FLOOR = "0.124.55";

export { estateRows, type ApprovedApply, type DriftRun, type EstateRowOptions, type EstateRows, type EstateTables, type GateLine, type PrEnvLine, type WaveJob } from "./ci-estate/rows";
export {
  appliesOf,
  buildDelivery,
  deliveryGauges,
  doraMetricNames,
  doraSchema,
  driftIncidents,
  duration,
  median,
  spanLabel,
  weekStart,
  DORA_FILE,
  DORA_MIN_SPAN_SECONDS,
  DORA_WEEKS,
  DRIFT_WINDOW_SECONDS,
  type DeliveryGauge,
  type DeliveryOptions,
  type Dora,
  type DoraLeadTime,
  type DoraMetrics,
  type DoraProject,
  type DoraWeek,
  type DriftIncident,
} from "./ci-estate/delivery";
export { ledgerOverdue, type DriftSchedule, type LedgerOverdue, type LedgerOverdueOptions } from "./ci-estate/overdue";
export {
  buildEstate,
  esc,
  estateSchema,
  memberState,
  renderDeliverySection,
  renderEstateHtml,
  ESTATE_FILES,
  RECENT_RUNS,
  type Estate,
  type EstateOptions,
  type EstatePrEnv,
  type EstateProject,
  type EstateRun,
  type EstateSections,
  type EstateWaiting,
} from "./ci-estate/page";
export { otlpMetricsBody, otlpMetricsFromEnv, sendOtlpGauges, type OtlpGauge, type OtlpGaugesSent, type OtlpMetricsConfig } from "./otlp-metrics";

export interface LedgerEstateInput extends EstateRowOptions {
  /** The tables, as `loadQueryData` returned them (a `QueryLoad`), or the tables alone. */
  load: QueryLoad | EstateTables;
  words?: Pick<CiProductWords, "product" | "stages" | "noun">;
  now?: Date;
  /** The members, in order. Default every member the ledger names. */
  members?: readonly string[];
  /** The scheduled drift checks to judge. Default none. */
  schedules?: readonly DriftSchedule[];
  /** When a member's schedule began, for one with no check on record. */
  added?: (op: string, member: string) => string | undefined;
  /** A commit's time in milliseconds, or null; given, a change's lead time starts no later than its commit. */
  commitTime?: (commit: string) => number | null;
}

export interface LedgerEstate {
  rows: EstateRows;
  estate: Estate;
  dora: Dora;
  overdue: LedgerOverdue[];
}

const tablesOf = (load: QueryLoad | EstateTables): { tables: EstateTables; malformed?: Record<string, number> } =>
  "data" in load ? { tables: load.data, malformed: load.malformed } : { tables: load };

/** The estate, the metrics and the overdue checks from one read of the ledger. */
export function buildLedgerEstate(input: LedgerEstateInput): LedgerEstate {
  const words = input.words ?? CHANT_WORDS;
  const now = input.now ?? new Date();
  const { tables, malformed } = tablesOf(input.load);
  const rows = estateRows(tables, { ...(input.project ? { project: input.project } : {}), ...(input.driftOps ? { driftOps: input.driftOps } : {}), ...(input.deployOps ? { deployOps: input.deployOps } : {}) });
  const members = input.members ?? rows.members;
  const overdue = ledgerOverdue(rows, input.schedules ?? [], { words, now, ...(input.added ? { added: input.added } : {}) });
  const dora = buildDelivery(rows, { words, now, members, ...(input.commitTime ? { commitTime: input.commitTime } : {}) });
  const estate = buildEstate(rows, dora, { words, now, members, overdue, ...(malformed ? { malformed } : {}) });
  return { rows, estate, dora, overdue };
}

/** The three files by name: `estate.json`, `estate.html` and `dora.json`. */
export function estateFiles(e: Pick<LedgerEstate, "estate" | "dora">, words: Pick<CiProductWords, "product" | "noun"> = CHANT_WORDS, sections: EstateSections = {}): Record<string, string> {
  return {
    [ESTATE_FILES.json]: JSON.stringify(e.estate, null, 2) + "\n",
    [ESTATE_FILES.page]: renderEstateHtml(e.estate, e.dora, words, sections),
    [ESTATE_FILES.dora]: JSON.stringify(e.dora, null, 2) + "\n",
  };
}

export interface WriteEstateOptions {
  /** The report store's put (`reportPut(parseReportUrl(ci.reportUrl))`). */
  put: ReportPut;
  /** The key prefix below the report URL. Default `estate`. */
  prefix?: string;
  words?: Pick<CiProductWords, "product" | "noun">;
  sections?: EstateSections;
  /** Files a product adds beside the three, by name. */
  extra?: Record<string, string>;
  /** The environment the OTLP endpoint is read from. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  fetch?: OtlpFetch;
}

export interface WriteEstateResult {
  /** The keys written, below the report URL. */
  keys: string[];
  /** The gauges: sent, or why not. Absent when no metrics endpoint is set. */
  metrics?: OtlpGaugesSent;
}

/** Write the page, its JSON and `dora.json` to the report store, and send the gauges when an endpoint is set. */
export async function writeEstate(e: Pick<LedgerEstate, "estate" | "dora">, options: WriteEstateOptions): Promise<WriteEstateResult> {
  const words = options.words ?? CHANT_WORDS;
  const prefix = (options.prefix ?? "estate").replace(/^\/+|\/+$/g, "");
  const files = { ...estateFiles(e, words, options.sections), ...(options.extra ?? {}) };
  const keys: string[] = [];
  for (const [name, body] of Object.entries(files)) {
    const key = prefix ? `${prefix}/${name}` : name;
    await options.put(key, body, name.endsWith(".html") ? "text/html; charset=utf-8" : "application/json");
    keys.push(key);
  }
  const metrics = await sendOtlpGauges(deliveryGauges(e.dora, words), { ...(options.env ? { env: options.env } : {}), ...(options.fetch ? { fetch: options.fetch } : {}), product: words.product });
  return { keys, ...(metrics ? { metrics } : {}) };
}

/**
 * Load the tables from the ledgers at `cwd`: every member's in a workspace,
 * else the project's own, from the local `chant/lifecycle` branch, as
 * `chant query` reads them. It never fetches.
 */
export async function readEstateLedger(cwd: string, members?: readonly string[]): Promise<QueryLoad> {
  const { queryLedgers } = await import("./cli/handlers/query");
  const { loadQueryData } = await import("./lifecycle/query");
  return loadQueryData(await queryLedgers(cwd, members));
}
