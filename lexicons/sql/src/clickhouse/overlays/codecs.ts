/**
 * Codec parameters and chaining: the overlay half.
 *
 * `system.codecs` gives the 17 names and their flags (compression, generic,
 * encryption, time series, experimental). The parameters (`ZSTD(level)`,
 * `Delta(bytes)`) and the order a chain like `CODEC(Delta, ZSTD(3))` must
 * follow are in no table.
 *
 * Every codec at the pin has an entry, and generation fails when one does not,
 * so a codec a pin move adds is a decision rather than a silent `string`.
 * `"unknown"` is that decision for the experimental codecs whose parameters
 * are not documented: they are accepted as written and not checked.
 */

import type { ArgumentOverlay } from "./kinds";

export interface CodecOverlay {
  /** Positional parameters, all optional unless marked otherwise; `"unknown"` when undocumented. */
  parameters: readonly (ArgumentOverlay & { name: string })[] | "unknown";
  /**
   * Where the codec sits in a chain. A `preprocessing` codec transforms values
   * for the compression codec that must follow it; `encryption` comes last;
   * `internal` is never written by hand.
   */
  role: "preprocessing" | "compression" | "encryption" | "none" | "internal";
}

const WIDTH: ArgumentOverlay & { name: string } = {
  name: "bytes",
  kind: "number",
  optional: true,
  values: ["1", "2", "4", "8"],
  note: "1, 2, 4 or 8; the column type's width when omitted.",
};

export const CODEC_OVERLAY: Record<string, CodecOverlay> = {
  NONE: { parameters: [], role: "none" },
  LZ4: { parameters: [], role: "compression" },
  LZ4HC: {
    parameters: [{ name: "level", kind: "number", optional: true, range: [0, 12], note: "9 when omitted or 0." }],
    role: "compression",
  },
  ZSTD: {
    parameters: [
      { name: "level", kind: "number", optional: true, range: [1, 22], note: "1 when omitted." },
      { name: "window_log", kind: "number", optional: true, range: [10, 31], note: "Turns on long-range matching with this window log." },
    ],
    role: "compression",
  },
  Delta: { parameters: [WIDTH], role: "preprocessing" },
  DoubleDelta: { parameters: [WIDTH], role: "compression" },
  Gorilla: { parameters: [WIDTH], role: "compression" },
  GCD: { parameters: [], role: "preprocessing" },
  T64: {
    parameters: [{ name: "variant", kind: "keyword", optional: true, values: ["'byte'", "'bit'"] }],
    role: "compression",
  },
  FPC: {
    parameters: [
      { name: "level", kind: "number", optional: true, range: [1, 28], note: "12 when omitted." },
      { name: "float_size", kind: "number", optional: true, values: ["4", "8"], note: "4 or 8; the column type's width when omitted." },
    ],
    role: "compression",
  },
  AES_128_GCM_SIV: { parameters: [], role: "encryption" },
  AES_256_GCM_SIV: { parameters: [], role: "encryption" },
  ALP: { parameters: "unknown", role: "compression" },
  SZ3: { parameters: "unknown", role: "compression" },
  ZXC: { parameters: "unknown", role: "compression" },
  Quantized: { parameters: "unknown", role: "preprocessing" },
  Multiple: { parameters: "unknown", role: "internal" },
};
