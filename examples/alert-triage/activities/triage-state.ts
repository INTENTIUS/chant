// The two files a triage in flight keeps, and the paths they live at.
//
// A triage spans two runs — one that proposes and stops at the gate, one that
// applies after somebody clears it — so the proposal has to outlive the
// process that made it. `.chant/triage/` is where it waits (gitignored; the
// example's .gitignore covers `.chant/`).
//
// Separate from run-triage.ts so importing a path or `stageAlert` does not
// drag that module's CLI dispatch along with it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Alert, Classification, Remediation, TriageContext } from "./triage.js";

const root = fileURLToPath(new URL("..", import.meta.url));

export const STATE_DIR = resolve(root, ".chant/triage");
/** What the event sources stage; what `propose` reads. */
export const ALERT_FILE = resolve(STATE_DIR, "alert.json");
/** What `propose` writes and a person reads before approving; what `apply` acts on. */
export const PROPOSAL_FILE = resolve(STATE_DIR, "current.json");

export interface Proposal {
  alert: Alert;
  classification: Classification;
  context: TriageContext;
  remediation: Remediation;
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Put an alert where the next `propose` will find it. Used by both event sources. */
export function stageAlert(alert: Alert): string {
  writeJson(ALERT_FILE, alert);
  return ALERT_FILE;
}
