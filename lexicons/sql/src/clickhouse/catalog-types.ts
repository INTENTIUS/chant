/**
 * The shapes of the generated ClickHouse catalog tables
 * (`src/generated/clickhouse.ts`). The data is generated; these types are
 * not, so the generated module stays data and a reader of it has one place to
 * look for what a field means.
 */

import type { ArgumentKind, ArgumentOverlay } from "./overlays/kinds";
import type { CodecOverlay } from "./overlays/codecs";
import type { EngineCapabilities } from "../spec/catalog";

export type { ArgumentKind, ArgumentOverlay, EngineCapabilities };

/** One engine or skip-index argument: its place in the syntax line, and its kind where the overlay knows it. */
export interface ArgumentSpec {
  name: string;
  position: number;
  optional: boolean;
  repeated: boolean;
  /** Written `name = value`. */
  named: boolean;
  /** `"unknown"` for an argument no overlay types; a quoted placeholder is always `string`. */
  kind: ArgumentKind | "unknown";
  values?: readonly string[];
  range?: readonly [number, number];
  note?: string;
}

export interface TableEngineSpec {
  capabilities: EngineCapabilities;
  /** The server's own usage line. */
  syntax: string;
  /**
   * The engine's arguments, or `undefined` when the syntax line is not an
   * `ENGINE = Name(...)` line the generator can read (`View`,
   * `MaterializedView`, `WindowView`, `Loop`).
   */
  args?: readonly ArgumentSpec[];
  /** True when an overlay types every argument. */
  typed: boolean;
  /** A MergeTree family member, Replicated or not. */
  mergeTree: boolean;
  /** For a `Replicated*` engine, the engine it replicates. */
  replicates?: string;
  summary: string;
}

export interface DatabaseEngineSpec {
  syntax: string;
  summary: string;
}

export interface TypeFamilySpec {
  /** The canonical family: itself, or what an alias stands for. */
  canonical: string;
  caseInsensitive: boolean;
}

export interface CodecSpec {
  compression: boolean;
  generic: boolean;
  encryption: boolean;
  timeseries: boolean;
  experimental: boolean;
  role: CodecOverlay["role"];
  parameters: CodecOverlay["parameters"];
  summary: string;
}

export interface SkipIndexSpec {
  syntax: string;
  args?: readonly ArgumentSpec[];
  summary: string;
}

export interface SettingSpec {
  /** The server's setting type (`UInt64`, `Bool`, `MergeSelectorAlgorithm`). */
  type: string;
  default: string;
  tier: string;
  obsolete: boolean;
  /** The server's `readonly` flag for the setting. */
  readonly: boolean;
}
