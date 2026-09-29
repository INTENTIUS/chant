/**
 * The Grafana schemas this lexicon's types are generated from.
 *
 * Grafana defines dashboards, panel options and datasource queries as CUE
 * kinds. `grafana/grafana-foundation-sdk` runs them through cog and
 * publishes, beside its builder libraries, one JSON Schema per kind under
 * `jsonschema/`. This lexicon vendors the files it uses into `src/spec/schemas/`
 * (exact bytes, at the commit below), applies the correction overlay in
 * `src/spec/overlay/` (see `src/spec/overlay.ts`), and generates
 * `src/schema/*.gen.ts` from the result. Nothing is fetched at build or test
 * time.
 *
 * The types track Grafana 12.4 and 13.x: v0.0.20 is labelled with the
 * v11.6.x kind registry, but its dashboard schema largely matches those
 * releases, and the overlay covers the rest.
 *
 * Bumping the pin: change `ref` and `commit`, run `just fetch-schemas`
 * (downloads and prints the new digests), paste the digests here, run
 * `npm run generate` (it refuses overlay patches the new schemas already
 * carry; delete those), and review the diff of `src/schema/`.
 */

export interface GrafanaSchemaPin {
  /** Where the schema files come from. */
  source: string;
  /** The tag the commit is published under. */
  ref: string;
  /** The exact commit the vendored files were taken from. */
  commit: string;
  /**
   * The kind registry label the SDK publishes the schemas under. It lags the
   * content: the v0.0.20 schemas are labelled v11.6.x and cover 12.4 and 13.x.
   */
  kindRegistry: string;
  /** sha256 of each vendored file, keyed by schema name (`src/spec/schemas/<name>.jsonschema.json`). */
  files: Readonly<Record<SchemaName, string>>;
}

export const SCHEMA_NAMES = [
  "dashboard",
  "timeseries",
  "stat",
  "gauge",
  "table",
  "logs",
  "heatmap",
  "text",
  "prometheus",
  "tempo",
  "loki",
  "expr",
] as const;

export type SchemaName = (typeof SCHEMA_NAMES)[number];

export const GRAFANA_SCHEMA_PIN: GrafanaSchemaPin = Object.freeze({
  source: "github.com/grafana/grafana-foundation-sdk/jsonschema",
  ref: "v0.0.20",
  commit: "d9e3417a1a40a0b42379cedbd270411e599fa492",
  kindRegistry: "v11.6.x",
  files: Object.freeze({
    dashboard: "67451cd5b288f97e3f68eccd52ffa4f75151fc87c669b8cd93c051056b294265",
    timeseries: "77ba36d66bbfcb363eeb5e6957813ca4b4cbc5a5bc4e8a12034d4c3b8cbbbde4",
    stat: "da547c8b1e52883a77e876f34d90d6034266ca8488a5601900ca26fc01d74b9e",
    gauge: "154f065b05b36c84ff1b372edc2c7ef5a5dde32adec77daddf6bf9fab726eb96",
    table: "eeaf780eb1be6fcd2ff0c098a1ba6eb051a8a37a0b2ea8db7c4d3bcdc5db6b97",
    logs: "0254600ef9720bd2c906628304a7c362c0182b4bff2fd7d91352d95a269b2dda",
    heatmap: "1e1905eef14ada48c121374ecad41412380b317e8183771d99a7504753d5005c",
    text: "db6d2e3e2c576d1c78ac2e08930f60dbc22bb7ee21abd0cd9204be49f0dbce09",
    prometheus: "726fc97eeb1e37791dbbf988c3cf40de17bb8e623926e6979c4a3f947cb1af87",
    tempo: "21aec4c333c9b8e5e9228e85a6225c76161975abb54002e6f12e919e3b4e54ae",
    loki: "03b81d6b952e3d31785c4b52637e2b7b1c170cc2ea8ec7ec671c21599508e31b",
    expr: "b1f1c1e4f6bf00f0fb4cb32b5bcc1b0e91fad9b7ad9354ecb791322bd97a5564",
  }),
});

/** The raw URL of one schema file at the pinned commit. */
export function schemaUrl(name: SchemaName, pin: GrafanaSchemaPin = GRAFANA_SCHEMA_PIN): string {
  return `https://raw.githubusercontent.com/grafana/grafana-foundation-sdk/${pin.commit}/jsonschema/${name}.jsonschema.json`;
}
