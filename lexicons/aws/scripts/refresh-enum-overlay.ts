#!/usr/bin/env tsx
/**
 * Refresh the curated enum overlay from its recorded sources (chant #1497).
 *
 * Manual only. It reaches the network, so it is deliberately not a package
 * script and nothing in `generate`, `bundle`, `validate` or `build` calls it:
 * `chant build` and the test suite read the checked-in
 * `src/codegen/enum-overlay.json` and nothing else.
 *
 *   npx tsx lexicons/aws/scripts/refresh-enum-overlay.ts            # report drift, exit 1 if any
 *   npx tsx lexicons/aws/scripts/refresh-enum-overlay.ts --write    # apply it and restamp `reviewed`
 *
 * Entries sourced from a botocore service model are refreshed automatically:
 * botocore is the same data cfn-lint derives its own enum patches from, and it
 * is machine-readable, so the diff is exact. Entries sourced from an AWS
 * documentation page are reported with their URL for a human to re-read, since
 * no machine-readable form of those lists exists.
 */

import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { EnumOverlayEntry } from "../src/codegen/enum-overlay";

const OVERLAY_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "src",
  "codegen",
  "enum-overlay.json",
);

const BOTOCORE_BASE = "https://raw.githubusercontent.com/boto/botocore/develop/botocore/data";

interface ServiceModel {
  shapes?: Record<string, { enum?: string[] }>;
}

const modelCache = new Map<string, Promise<ServiceModel>>();

function serviceModel(service: string, apiVersion: string): Promise<ServiceModel> {
  const url = `${BOTOCORE_BASE}/${service}/${apiVersion}/service-2.json`;
  let pending = modelCache.get(url);
  if (!pending) {
    pending = (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url} returned ${res.status}`);
      return (await res.json()) as ServiceModel;
    })();
    modelCache.set(url, pending);
  }
  return pending;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function difference(a: string[], b: string[]): string[] {
  const other = new Set(b);
  return a.filter((v) => !other.has(v));
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const document = JSON.parse(readFileSync(OVERLAY_PATH, "utf-8")) as {
    entries: EnumOverlayEntry[];
  };

  let drifted = 0;
  let manual = 0;

  for (const entry of document.entries) {
    const where = `${entry.type}${entry.pointer}`;

    if (entry.source.kind === "docs") {
      manual++;
      console.log(`manual  ${where}`);
      console.log(`        ${entry.values.length} value(s), last read ${entry.reviewed}`);
      console.log(`        ${entry.source.url}`);
      continue;
    }

    const { service, apiVersion, shape } = entry.source;
    let model: ServiceModel;
    try {
      model = await serviceModel(service, apiVersion);
    } catch (err) {
      console.error(`FAILED  ${where}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      continue;
    }

    const upstream = model.shapes?.[shape]?.enum;
    if (!upstream) {
      console.error(`FAILED  ${where}: botocore ${service} has no enum shape ${shape}`);
      process.exitCode = 1;
      continue;
    }

    const fresh = [...new Set(upstream)].sort();
    const added = difference(fresh, entry.values);
    const removed = difference(entry.values, fresh);

    if (added.length === 0 && removed.length === 0) {
      console.log(`ok      ${where} (${entry.values.length})`);
      continue;
    }

    drifted++;
    console.log(`drift   ${where}`);
    if (added.length > 0) console.log(`        + ${added.join(", ")}`);
    // A removed value is worth a second look before it is applied: narrowing
    // further is the half of a refresh that can break a template that compiles
    // today.
    if (removed.length > 0) console.log(`        - ${removed.join(", ")}`);

    if (write) {
      entry.values = fresh;
      entry.reviewed = today();
    }
  }

  if (write && drifted > 0) {
    writeFileSync(OVERLAY_PATH, `${JSON.stringify(document, null, 2)}\n`);
    console.log(`\nrewrote ${OVERLAY_PATH} (${drifted} entr${drifted === 1 ? "y" : "ies"})`);
    console.log("Run `npm run generate` in lexicons/aws and re-check the surface before committing.");
    return;
  }

  console.log(
    `\n${drifted} entr${drifted === 1 ? "y" : "ies"} drifted, ${manual} need a human to re-read the docs page.`,
  );
  if (drifted > 0) {
    console.log("Re-run with --write to apply the botocore half.");
    process.exitCode = 1;
  }
}

await main();
