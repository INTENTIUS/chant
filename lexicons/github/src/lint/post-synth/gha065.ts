/**
 * GHA065: Unbounded Matrix Fan-Out
 *
 * Flags a `strategy.matrix` that combines two or more dimensions into more
 * jobs than a `max-parallel:` cap bounds. Two orthogonal axes each with a
 * handful of values multiply, not add — `os` x `node` x `arch` can produce
 * dozens of jobs from a config that reads like a short list. Unbounded, that
 * is capacity spent on a combination nobody asked for, not a correctness or
 * security issue (efficiency, #444).
 *
 * Parses the `matrix:` block by indentation, not the structural YAML parser
 * — a flow list of bare words (`os: [ubuntu-latest, macos-latest]`, the
 * overwhelmingly common hand-written form) is not one it round-trips, only
 * a flow list of numbers. Mirrors GHA009's regex-based matrix handling for
 * the same reason.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs } from "./yaml-helpers";

/** Above this many combinations, an uncapped matrix is flagged. */
const FANOUT_THRESHOLD = 12;

/** The raw text of one job's block within `jobs:`, or undefined if not found. */
function jobSection(yaml: string, jobName: string): string | undefined {
  const jobsIdx = yaml.search(/^jobs:\s*$/m);
  if (jobsIdx === -1) return undefined;
  const afterJobs = yaml.slice(jobsIdx + yaml.slice(jobsIdx).indexOf("\n") + 1);
  const header = `  ${jobName}:\n`;
  const start = afterJobs.indexOf(header);
  if (start === -1) return undefined;
  const rest = afterJobs.slice(start + header.length);
  const nextJobMatch = rest.search(/\n {2}\S/);
  return nextJobMatch === -1 ? rest : rest.slice(0, nextJobMatch);
}

interface MatrixInfo {
  dims: Array<{ key: string; size: number }>;
  maxParallel: boolean;
}

/** Parse a job section's `strategy.matrix` dimensions and whether max-parallel caps it. */
function parseMatrix(section: string): MatrixInfo | undefined {
  const lines = section.split("\n");
  const matrixLineIdx = lines.findIndex((l) => /^\s*matrix:\s*$/.test(l));
  if (matrixLineIdx === -1) return undefined;
  const matrixIndent = lines[matrixLineIdx].search(/\S/);

  const maxParallel = lines.some((l) => {
    const m = l.match(/^(\s*)max-parallel:/);
    return !!m && m[1].length === matrixIndent;
  });

  const dims: Array<{ key: string; size: number }> = [];
  let i = matrixLineIdx + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    const indent = line.search(/\S/);
    if (indent <= matrixIndent) break; // dedented out of the matrix: block

    const kv = line.match(/^\s*([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!kv) { i++; continue; }
    const [, key, rest] = kv;
    const value = rest.trim();

    if (value.startsWith("[")) {
      const inner = value.replace(/^\[|\]\s*$/g, "").trim();
      dims.push({ key, size: inner === "" ? 0 : inner.split(",").length });
      i++;
      continue;
    }
    if (value !== "") {
      dims.push({ key, size: 1 }); // a bare scalar dimension
      i++;
      continue;
    }
    // Block-list value on subsequent, deeper-indented lines.
    let size = 0;
    i++;
    while (i < lines.length) {
      const l2 = lines[i];
      if (l2.trim() === "") { i++; continue; }
      const ind2 = l2.search(/\S/);
      if (ind2 <= indent) break;
      if (/^\s*-\s/.test(l2)) size++;
      i++;
    }
    dims.push({ key, size });
  }

  return { dims, maxParallel };
}

export const gha065: PostSynthCheck = {
  id: "GHA065",
  description: "Matrix combines dimensions into an uncapped, large fan-out",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);

      for (const [jobName] of extractJobs(yaml)) {
        const section = jobSection(yaml, jobName);
        if (!section) continue;
        const matrix = parseMatrix(section);
        if (!matrix) continue;

        const dims = matrix.dims.filter((d) => d.key !== "include" && d.key !== "exclude" && d.size > 0);
        if (dims.length < 2) continue; // a single axis isn't "combined" fan-out

        const combos = dims.reduce((a, d) => a * d.size, 1);
        if (combos <= FANOUT_THRESHOLD || matrix.maxParallel) continue;

        diagnostics.push({
          checkId: "GHA065",
          severity: "info",
          message: `Job "${jobName}"'s matrix combines ${dims.length} dimensions (${dims.map((d) => d.key).join(" x ")}) into ${combos} jobs with no \`max-parallel:\` cap. Confirm the full cross-product is intended, trim it with \`include\`/\`exclude\`, or add \`max-parallel:\`.`,
          entity: jobName,
          lexicon: "github",
        });
      }
    }

    return diagnostics;
  },
};
