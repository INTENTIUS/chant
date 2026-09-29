/**
 * Panel transformations, typed per transformer.
 *
 * The dashboard schema types a transformation as `{ id: string; options:
 * {} }`: foundation-sdk v0.0.20 has no schema for any transformer's options.
 * The option types below are transcribed from the transformers Grafana
 * v13.2.2 registers (tag v13.2.2, commit
 * 3db12332b66497c31f8ad2a5fb0eb0fe0ca05a7e):
 *
 * - `packages/grafana-data/src/transformations/transformers/<id>.ts` for the
 *   standard transformers, `transformers/ids.ts` for their ids;
 * - `public/app/features/transformers/**` for the ones the app registers
 *   (heatmap, extractFields, configFromData, rowsToFields, joinByLabels,
 *   partitionByValues, prepareTimeSeries, timeSeriesTable, regression,
 *   smoothing, spatial, fieldLookup);
 * - enums from `fieldReducer.ts` (ReducerID), `utils/binaryOperators.ts`,
 *   `utils/unaryOperators.ts`, `types/dataFrame.ts` (FieldType,
 *   EnumFieldConfig), `types/data.ts` (NullValueMode),
 *   `types/transformations.ts` (SpecialValue),
 *   `transformers/joinShared.ts` (JoinMode) and
 *   `matchers/nameMatcher.ts` (RegexpOrNamesMatcherOptions).
 *
 * Every top-level option is optional: Grafana spreads each transformer's
 * `defaultOptions` under the stored options before it runs
 * (`transformDataFrame`), so a dashboard stores only what was set. Nested
 * objects keep Grafana's required fields.
 *
 * A transformation whose id Grafana doesn't register (a plugin's), or whose
 * options this file doesn't know, goes through `customTransformation()`.
 */

import type { MatcherConfig } from "./schema/dashboard.gen";
import type { HeatmapCalculationOptions } from "./schema/heatmap.gen";
import type { FrameGeometrySource } from "./schema/geomap.gen";

// ── Shared enums (as the string values Grafana stores) ──────────

/** `ReducerID` in `fieldReducer.ts`. */
export type ReducerId =
  | "sum"
  | "max"
  | "min"
  | "logmin"
  | "mean"
  | "variance"
  | "stdDev"
  | "last"
  | "median"
  | "first"
  | "count"
  | "countAll"
  | "range"
  | "diff"
  | "diffperc"
  | "delta"
  | "step"
  | "firstNotNull"
  | "lastNotNull"
  | "changeCount"
  | "distinctCount"
  | "allIsZero"
  | "allIsNull"
  | "allValues"
  | "uniqueValues"
  | `p${Percentile}`;

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type NonZeroDigit = Exclude<Digit, "0">;
/** p1 to p99. */
type Percentile = NonZeroDigit | `${NonZeroDigit}${Digit}`;

/** `FieldType` in `types/dataFrame.ts`. */
export type FieldTypeId = "time" | "number" | "string" | "boolean" | "trace" | "geo" | "enum" | "other" | "frame" | "nestedFrames";

/** `SpecialValue` in `types/transformations.ts`. */
export type SpecialValue = "true" | "false" | "null" | "empty" | "zero";

/** `NullValueMode` in `types/data.ts`. */
export type NullValueMode = "null" | "connected" | "null as zero";

/** `RegexpOrNamesMatcherOptions` in `matchers/nameMatcher.ts`. */
export interface RegexpOrNamesMatcherOptions {
  pattern?: string;
  names?: string[];
  variable?: string;
}

// ── Standard transformers (packages/grafana-data) ───────────────

/** `calculateField.ts`. */
export interface CalculateFieldOptions {
  timeSeries?: boolean;
  mode?: "reduceRow" | "cumulativeFunctions" | "windowFunctions" | "binary" | "unary" | "index";
  reduce?: { include?: string[]; reducer: ReducerId; nullValueMode?: NullValueMode };
  window?: {
    field?: string;
    reducer: ReducerId;
    windowSize?: number;
    windowSizeMode?: "percentage" | "fixed";
    windowAlignment?: "trailing" | "centered";
  };
  cumulative?: { field?: string; reducer: ReducerId };
  binary?: { left: CalculateFieldBinaryValue; operator: "+" | "-" | "/" | "*"; right: CalculateFieldBinaryValue };
  unary?: { operator: "abs" | "exp" | "ln" | "round" | "floor" | "ceil" | "percent"; fieldName: string };
  index?: { asPercentile: boolean };
  replaceFields?: boolean;
  alias?: string;
}

/**
 * One side of a binary calculation. Grafana 10.3 and later store
 * `{ fixed }` or `{ matcher: { id: "byName", options } }`; older
 * dashboards store the field name or number as a plain string, which
 * Grafana still reads.
 */
export type CalculateFieldBinaryValue = string | { fixed?: string; matcher?: { id?: string; options?: string } };

/** `concat.ts`. */
export interface ConcatenateOptions {
  frameNameMode?: "drop" | "field" | "label";
  frameNameLabel?: string;
}

/** `convertFieldType.ts`. */
export interface ConvertFieldTypeOptions {
  conversions?: Array<{
    targetField?: string;
    destinationType?: FieldTypeId;
    dateFormat?: string;
    joinWith?: string;
    timezone?: string;
    enumConfig?: { text?: string[]; color?: string[]; icon?: string[]; description?: string[] };
  }>;
}

/** `convertFrameType.ts`. */
export interface ConvertFrameTypeOptions {
  targetType?: "exemplar" | "timeRegion" | "annotation";
}

/** `filter.ts` (filterFields and filterFrames). */
export interface FilterOptions {
  include?: MatcherConfig;
  exclude?: MatcherConfig;
}

/** `filterByName.ts`. */
export interface FilterFieldsByNameOptions {
  include?: RegexpOrNamesMatcherOptions;
  exclude?: RegexpOrNamesMatcherOptions;
  byVariable?: boolean;
}

/** `filterByRefId.ts`. */
export interface FilterByRefIdOptions {
  include?: string;
  exclude?: string;
}

/** `filterByValue.ts`. `config` is a value matcher: `{ id: "greater", options: { value: 10 } }`. */
export interface FilterByValueOptions {
  filters?: Array<{ fieldName: string; config: MatcherConfig }>;
  type?: "exclude" | "include";
  match?: "all" | "any";
}

/** `formatString.ts`. */
export interface FormatStringOptions {
  stringField?: string;
  substringStart?: number;
  substringEnd?: number;
  outputFormat?:
    | "Upper Case"
    | "Lower Case"
    | "Sentence Case"
    | "Title Case"
    | "Pascal Case"
    | "Camel Case"
    | "Snake Case"
    | "Kebab Case"
    | "Trim"
    | "Substring";
}

/** `formatTime.ts`. `useTimezone` is in its `defaultOptions`. */
export interface FormatTimeOptions {
  timeField?: string;
  outputFormat?: string;
  timezone?: string;
  useTimezone?: boolean;
}

/** `groupBy.ts`, per field. */
export interface GroupByFieldOptions {
  aggregations: ReducerId[];
  operation: "aggregate" | "groupby" | null;
}

/** `groupBy.ts`. */
export interface GroupByOptions {
  fields?: Record<string, GroupByFieldOptions>;
}

/** `groupToNestedTable.ts`: per-field options, or (V2) matcher rules. */
export interface GroupToNestedTableOptions {
  showSubframeHeaders?: boolean;
  expandAllRows?: boolean;
  fields?: Record<string, GroupByFieldOptions>;
  rules?: Array<{
    matcher: MatcherConfig;
    operation: "aggregate" | "groupby" | null;
    aggregations: ReducerId[];
    keepNestedField?: boolean;
  }>;
}

/** `groupingToMatrix.ts`. */
export interface GroupingToMatrixOptions {
  columnField?: string;
  rowField?: string;
  valueField?: string;
  emptyValue?: SpecialValue;
}

/** `histogram.ts`. The editor stores sizes and offsets as numbers or strings. */
export interface HistogramOptions {
  bucketCount?: number;
  bucketSize?: number | string;
  bucketOffset?: number | string;
  combine?: boolean;
}

/** `joinByField.ts` (and the deprecated `seriesToColumns`). */
export interface JoinByFieldOptions {
  byField?: string;
  mode?: "outer" | "inner" | "outerTabular";
}

/** `labelsToFields.ts`. */
export interface LabelsToFieldsOptions {
  mode?: "columns" | "rows";
  keepLabels?: string[];
  valueLabel?: string;
}

/** `limit.ts`. A string is a variable reference. */
export interface LimitOptions {
  limitField?: number | string;
}

/** `order.ts`. */
export interface OrderOptions {
  indexByName?: Record<string, number>;
  orderByMode?: "manual" | "auto";
  orderBy?: Array<{ type: "name" | "label"; name?: string; desc?: boolean }>;
}

/** `rename.ts`. */
export interface RenameOptions {
  renameByName?: Record<string, string>;
}

/** `organize.ts`: order, rename and exclude in one. */
export interface OrganizeOptions extends OrderOptions, RenameOptions {
  excludeByName?: Record<string, boolean>;
  includeByName?: Record<string, boolean>;
}

/** `reduce.ts`. `fields` limits which fields are reduced. */
export interface ReduceOptions {
  reducers?: ReducerId[];
  fields?: MatcherConfig;
  mode?: "seriesToRows" | "reduceFields";
  includeTimeField?: boolean;
  labelsToFields?: boolean;
}

/** `renameByRegex.ts`. */
export interface RenameByRegexOptions {
  regex?: string;
  renamePattern?: string;
}

/** `sortBy.ts`. Grafana uses only the first entry. */
export interface SortByOptions {
  sort?: Array<{ field: string; desc?: boolean; index?: number }>;
}

/** `transpose.ts`. */
export interface TransposeOptions {
  firstFieldName?: string;
  restFieldsName?: string;
  emptyValue?: SpecialValue;
}

/** A transformer that takes no options (merge, noop, seriesToRows, ensureColumns). */
export type NoOptions = Record<string, never>;

// ── Transformers the app registers (public/app/features/transformers) ──

/** `fieldToConfigMapping/fieldToConfigMapping.ts`. */
export interface FieldToConfigMapping {
  fieldName: string;
  reducerId?: ReducerId;
  handlerKey: string | null;
  handlerArguments?: { threshold?: { color?: string } };
}

/** `configFromQuery/configFromQuery.ts`. */
export interface ConfigFromDataOptions {
  configRefId?: string;
  mappings?: FieldToConfigMapping[];
  applyTo?: MatcherConfig;
}

/** `extractFields/types.ts`. */
export interface ExtractFieldsOptions {
  source?: string;
  jsonPaths?: Array<{ path: string; alias?: string }>;
  delimiter?: string;
  regExp?: string;
  format?: "json" | "kvp" | "auto" | "regexp" | "delimiter";
  replace?: boolean;
  keepTime?: boolean;
}

/** `lookupGazetteer/fieldLookup.ts`. */
export interface FieldLookupOptions {
  lookupField?: string;
  gazetteer?: string;
}

/** `calculateHeatmap/heatmap.ts`: the heatmap panel's calculation options, plus `keepOriginalData`. */
export interface HeatmapTransformOptions extends HeatmapCalculationOptions {
  keepOriginalData?: boolean;
}

/** `joinByLabels/joinByLabels.ts`. */
export interface JoinByLabelsOptions {
  value?: string;
  join?: string[];
}

/** `partitionByValues/partitionByValues.ts`. */
export interface PartitionByValuesOptions {
  fields?: string[];
  naming?: { asLabels?: boolean; append?: boolean; withNames?: boolean; separator1?: string; separator2?: string };
  keepFields?: boolean;
}

/** `prepareTimeSeries/prepareTimeSeries.ts`. */
export interface PrepareTimeSeriesOptions {
  format?: "wide" | "long" | "multi" | "many";
}

/** `regression/regression.ts`. */
export interface RegressionOptions {
  modelType?: "linear" | "polynomial";
  degree?: number;
  xFieldName?: string;
  yFieldName?: string;
  predictionCount?: number;
}

/** `rowsToFields/rowsToFields.ts`. */
export interface RowsToFieldsOptions {
  nameField?: string;
  valueField?: string;
  mappings?: FieldToConfigMapping[];
}

/** `smoothing/smoothing.ts`. */
export interface SmoothingOptions {
  resolution?: number;
}

/** `spatial/models.gen.ts`. */
export interface SpatialOptions {
  action?: "prepare" | "calculate" | "modify";
  source?: FrameGeometrySource;
  calculate?: { calc?: "heading" | "distance" | "area"; field?: string };
  modify?: { op: "asLine" | "lineBuilder"; target?: FrameGeometrySource };
}

/** `timeSeriesTable/timeSeriesTableTransformer.ts`: per query refId. */
export type TimeSeriesTableOptions = Record<string, { stat?: ReducerId; timeField?: string; inlineStat?: boolean }>;

// ── The id -> options map ───────────────────────────────────────

/** Every transformer Grafana v13.2.2 registers, by the id a dashboard stores, and its options. */
export interface TransformationOptionsById {
  calculateField: CalculateFieldOptions;
  concatenate: ConcatenateOptions;
  configFromData: ConfigFromDataOptions;
  convertFieldType: ConvertFieldTypeOptions;
  convertFrameType: ConvertFrameTypeOptions;
  ensureColumns: NoOptions;
  extractFields: ExtractFieldsOptions;
  fieldLookup: FieldLookupOptions;
  filterByRefId: FilterByRefIdOptions;
  filterByValue: FilterByValueOptions;
  filterFields: FilterOptions;
  filterFieldsByName: FilterFieldsByNameOptions;
  filterFrames: FilterOptions;
  formatString: FormatStringOptions;
  formatTime: FormatTimeOptions;
  groupBy: GroupByOptions;
  groupToNestedTable: GroupToNestedTableOptions;
  groupingToMatrix: GroupingToMatrixOptions;
  heatmap: HeatmapTransformOptions;
  histogram: HistogramOptions;
  joinByField: JoinByFieldOptions;
  joinByLabels: JoinByLabelsOptions;
  labelsToFields: LabelsToFieldsOptions;
  limit: LimitOptions;
  merge: NoOptions;
  noop: NoOptions;
  order: OrderOptions;
  organize: OrganizeOptions;
  partitionByValues: PartitionByValuesOptions;
  prepareTimeSeries: PrepareTimeSeriesOptions;
  reduce: ReduceOptions;
  regression: RegressionOptions;
  rename: RenameOptions;
  renameByRegex: RenameByRegexOptions;
  rowsToFields: RowsToFieldsOptions;
  /** Deprecated in Grafana for `joinByField`, which takes the same options. */
  seriesToColumns: JoinByFieldOptions;
  seriesToRows: NoOptions;
  smoothing: SmoothingOptions;
  sortBy: SortByOptions;
  spatial: SpatialOptions;
  timeSeriesTable: TimeSeriesTableOptions;
  transpose: TransposeOptions;
}

export type TransformationId = keyof TransformationOptionsById;

/** The fields every transformation has besides its id and options (`DataTransformerConfig`). */
export interface TransformationCommon {
  /** A disabled transformation is skipped. */
  disabled?: boolean;
  /** Apply it only to the frames this matcher selects. */
  filter?: MatcherConfig;
  /** Where its input frames come from. */
  topic?: "series" | "annotations" | "alertStates";
}

/** A transformation Grafana registers, with its options typed. */
export type KnownTransformation = {
  [K in TransformationId]: TransformationCommon & { id: K; options?: TransformationOptionsById[K] };
}[TransformationId];

declare const custom: unique symbol;

/** A transformation built by `customTransformation()`: any id, untyped options. */
export interface CustomTransformation extends TransformationCommon {
  id: string;
  options: Record<string, unknown>;
  /** Type-only: a plain object literal can't pose as one, so a typo in a known id or option is still an error. */
  readonly [custom]: true;
}

/** What a panel's `transformations` takes. */
export type Transformation = KnownTransformation | CustomTransformation;

/**
 * A transformation Grafana registers, typed by its id:
 *
 * ```ts
 * transformation("organize", { excludeByName: { Time: true }, renameByName: { Value: "Requests" } })
 * ```
 *
 * The same as writing `{ id: "organize", options: { ... } }` in `transformations`.
 */
export function transformation<K extends TransformationId>(
  id: K,
  options: TransformationOptionsById[K] = {} as TransformationOptionsById[K],
  common: TransformationCommon = {},
): Extract<KnownTransformation, { id: K }> {
  return { id, options, ...common } as Extract<KnownTransformation, { id: K }>;
}

/**
 * A transformation with any id and options, for a plugin's transformer, or
 * options newer than the ones typed here. Written to the dashboard as given,
 * with any other keys in `common` beside them.
 */
export function customTransformation(
  id: string,
  options: Record<string, unknown> = {},
  common: TransformationCommon & Record<string, unknown> = {},
): CustomTransformation {
  return { id, options, ...common } as CustomTransformation;
}

// ── Runtime tables, for the importer ─────────────────────────────

type KeysOf<T> = { [P in keyof Required<T>]: true };

/**
 * The top-level option keys of each transformer. Typed so that a key added
 * to or removed from an options interface above must be changed here too.
 */
const OPTION_KEYS: { [K in TransformationId]: KeysOf<TransformationOptionsById[K]> | "any" } = {
  calculateField: { timeSeries: true, mode: true, reduce: true, window: true, cumulative: true, binary: true, unary: true, index: true, replaceFields: true, alias: true },
  concatenate: { frameNameMode: true, frameNameLabel: true },
  configFromData: { configRefId: true, mappings: true, applyTo: true },
  convertFieldType: { conversions: true },
  convertFrameType: { targetType: true },
  ensureColumns: {},
  extractFields: { source: true, jsonPaths: true, delimiter: true, regExp: true, format: true, replace: true, keepTime: true },
  fieldLookup: { lookupField: true, gazetteer: true },
  filterByRefId: { include: true, exclude: true },
  filterByValue: { filters: true, type: true, match: true },
  filterFields: { include: true, exclude: true },
  filterFieldsByName: { include: true, exclude: true, byVariable: true },
  filterFrames: { include: true, exclude: true },
  formatString: { stringField: true, substringStart: true, substringEnd: true, outputFormat: true },
  formatTime: { timeField: true, outputFormat: true, timezone: true, useTimezone: true },
  groupBy: { fields: true },
  groupToNestedTable: { showSubframeHeaders: true, expandAllRows: true, fields: true, rules: true },
  groupingToMatrix: { columnField: true, rowField: true, valueField: true, emptyValue: true },
  heatmap: { xBuckets: true, yBuckets: true, keepOriginalData: true },
  histogram: { bucketCount: true, bucketSize: true, bucketOffset: true, combine: true },
  joinByField: { byField: true, mode: true },
  joinByLabels: { value: true, join: true },
  labelsToFields: { mode: true, keepLabels: true, valueLabel: true },
  limit: { limitField: true },
  merge: {},
  noop: {},
  order: { indexByName: true, orderByMode: true, orderBy: true },
  organize: { indexByName: true, orderByMode: true, orderBy: true, renameByName: true, excludeByName: true, includeByName: true },
  partitionByValues: { fields: true, naming: true, keepFields: true },
  prepareTimeSeries: { format: true },
  reduce: { reducers: true, fields: true, mode: true, includeTimeField: true, labelsToFields: true },
  regression: { modelType: true, degree: true, xFieldName: true, yFieldName: true, predictionCount: true },
  rename: { renameByName: true },
  renameByRegex: { regex: true, renamePattern: true },
  rowsToFields: { nameField: true, valueField: true, mappings: true },
  seriesToColumns: { byField: true, mode: true },
  seriesToRows: {},
  smoothing: { resolution: true },
  sortBy: { sort: true },
  spatial: { action: true, source: true, calculate: true, modify: true },
  // Keyed by query refId.
  timeSeriesTable: "any",
  transpose: { firstFieldName: true, restFieldsName: true, emptyValue: true },
};

export const TRANSFORMATION_IDS: readonly TransformationId[] = Object.keys(OPTION_KEYS) as TransformationId[];

const COMMON_KEYS = new Set(["id", "options", "disabled", "filter", "topic"]);

/**
 * Why a transformation as stored can't be written as a typed one, or
 * undefined when it can: an id Grafana doesn't register, a key beside
 * `options` the config doesn't have, or an option key its transformer
 * doesn't take.
 */
export function untypedTransformationReason(t: Record<string, unknown>): string | undefined {
  const id = t.id;
  if (typeof id !== "string" || !(id in OPTION_KEYS)) return `"${String(id)}" is not a transformer Grafana v13.2.2 registers`;
  const extra = Object.keys(t).filter((k) => !COMMON_KEYS.has(k));
  if (extra.length > 0) return `it has ${extra.map((k) => `"${k}"`).join(", ")} beside its id and options`;
  const options = t.options;
  if (options === undefined) return undefined;
  if (typeof options !== "object" || options === null || Array.isArray(options)) return "its options are not an object";
  const keys = OPTION_KEYS[id as TransformationId];
  if (keys === "any") return undefined;
  const unknown = Object.keys(options).filter((k) => !(k in keys));
  if (unknown.length > 0) return `the ${id} transformer takes no option${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")}`;
  return undefined;
}
