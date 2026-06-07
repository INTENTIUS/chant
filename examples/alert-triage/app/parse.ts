// Pure mappers from each event source into the triage `Alert` shape.
// Kept separate (and free of Temporal/IO) so they're unit-tested in CI.
import type { Alert } from "../activities/triage";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Normalize an incoming webhook body (Datadog/PagerDuty-ish) into an Alert. */
export function alertFromWebhook(body: unknown): Alert {
  const b = (body ?? {}) as Record<string, unknown>;
  const title =
    str(b.title) ?? str(b.summary) ?? str((b.alert as Record<string, unknown>)?.title) ?? "untitled alert";
  return {
    id: str(b.id) ?? str(b.alert_id) ?? `webhook-${slug(title)}`,
    title,
    body: str(b.body) ?? str(b.message) ?? str(b.description),
    source: str(b.source) ?? "webhook",
  };
}

/** A drifted resource from `chant lifecycle diff --json`. */
export interface DriftEntry {
  name: string;
  category?: string;
  type?: string;
}

/** Turn a drift entry into an Alert the same triage workflow handles. */
export function alertFromDrift(entry: DriftEntry): Alert {
  const what = entry.type ? `${entry.type} ${entry.name}` : entry.name;
  return {
    id: `drift-${slug(entry.name)}`,
    title: `Drift detected: ${what}${entry.category ? ` (${entry.category})` : ""}`,
    body: `Live state diverged from declared source for ${what}.`,
    source: "watchop",
  };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "alert";
}
