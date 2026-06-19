import { spawn } from "node:child_process";

/**
 * Layout-position export — node coordinates a custom painter consumes (the
 * rackattack pattern: Graphviz lays out, the painter draws). Graphviz is used
 * for LAYOUT ONLY; its rendering is discarded. See issue #497 / epic #492.
 *
 * The {@link LayoutEngine} interface exists so a pure-JS engine (elkjs/dagre)
 * can drop in later for a zero-native-dependency path — closing the install gap
 * so a painter can run without `dot`.
 */

/** A laid-out position in the engine's coordinate space. */
export interface Point {
  x: number;
  y: number;
}

/** Node positions plus the overall canvas size a painter needs. */
export interface Layout {
  /** Canvas width in the engine's coordinate space. */
  width: number;
  /** Canvas height in the engine's coordinate space. */
  height: number;
  /** Each node's centre position, ordered by id for deterministic output. */
  nodes: Array<{ id: string } & Point>;
}

/** Turns DOT into node positions. The painter consumes the result; it never
 * asks the engine to paint. */
export interface LayoutEngine {
  readonly name: string;
  layout(dot: string): Promise<Layout>;
}

/** Layout via `dot -Tjson`. Requires Graphviz (`brew install graphviz`). */
export class GraphvizLayout implements LayoutEngine {
  readonly name = "graphviz";

  async layout(dot: string): Promise<Layout> {
    return parseDotJson(await runDot(dot));
  }
}

function runDot(dot: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn("dot", ["-Tjson"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      reject(installHint(err));
      return;
    }
    let out = "";
    let errOut = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (errOut += d));
    proc.on("error", (err) => reject(installHint(err)));
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`dot exited ${code}: ${errOut.trim()}`));
      else resolve(out);
    });
    proc.stdin.write(dot);
    proc.stdin.end();
  });
}

function installHint(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(
    `could not run 'dot' (${msg}). Graphviz is required for --format layout — ` +
      `install it with 'brew install graphviz', or use --format mermaid, which needs no native dependency.`,
  );
}

interface DotJson {
  bb?: string;
  objects?: Array<{ name?: string; pos?: string }>;
}

/** Parse `dot -Tjson` output into a {@link Layout}. Pure; exported for testing. */
export function parseDotJson(json: string): Layout {
  const parsed = JSON.parse(json) as DotJson;
  const bb = (parsed.bb ?? "").split(",");
  if (bb.length !== 4) throw new Error(`bad bounding box ${parsed.bb}`);
  const width = num(bb[2]);
  const height = num(bb[3]);
  if (width === 0 || height === 0) throw new Error("zero graph bounds");

  const nodes: Array<{ id: string } & Point> = [];
  for (const o of parsed.objects ?? []) {
    if (!o.name || !o.pos) continue;
    const p = o.pos.split(",");
    if (p.length !== 2) continue;
    nodes.push({ id: o.name, x: num(p[0]), y: num(p[1]) });
  }
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  return { width, height, nodes };
}

function num(s: string): number {
  const f = Number.parseFloat(s.trim());
  return Number.isFinite(f) ? f : 0;
}
