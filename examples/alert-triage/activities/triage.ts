// Triage activities — plain async functions the Temporal worker registers.
//
// These are raw Temporal activities (not chant Op steps): the triage workflow is
// custom app logic, so it's hand-written Temporal with chant synthesizing the
// manifests around it. See chant's "Raw Temporal + chant" deployment path.
//
// The agent is stubbed by default — deterministic, no key, runs in CI and
// offline. When ANTHROPIC_API_KEY is set, `proposeRemediation` calls Claude.
import { ApplicationFailure } from "@temporalio/common";

export interface Alert {
  id: string;
  title: string;
  body?: string;
  source?: string;
}

export type Severity = "low" | "medium" | "high" | "critical";

export interface Classification {
  severity: Severity;
  rationale: string;
}

export interface TriageContext {
  signals: string[];
}

export interface Remediation {
  summary: string;
  /** Risky remediations route through the human-approval gate. */
  risky: boolean;
}

/** High/critical alerts always route through the gate, whatever the agent says. */
function severityRisky(severity: Severity): boolean {
  return severity === "high" || severity === "critical";
}

/**
 * Combine the agent's parsed reply with the alert severity. The agent may
 * *escalate* (call a low-severity alert risky) but never *de-escalate*: a
 * high/critical alert always routes through the gate even if the model calls it
 * SAFE. This keeps the agent path gating at least as strictly as the
 * deterministic stub.
 */
export function withSeverityFloor(parsed: Remediation, severity: Severity): Remediation {
  return { summary: parsed.summary, risky: parsed.risky || severityRisky(severity) };
}

/** Classify severity. Deterministic stub: keyword heuristic. */
export async function classifyAlert(alert: Alert): Promise<Classification> {
  const text = `${alert.title} ${alert.body ?? ""}`.toLowerCase();
  const severity: Severity = /\b(outage|down|unavailable)\b/.test(text)
    ? "critical"
    : /\b(error|fail|failed|crash)\b/.test(text)
      ? "high"
      : /\b(warn|warning|degraded)\b/.test(text)
        ? "medium"
        : "low";
  return { severity, rationale: `keyword heuristic over "${alert.title}"` };
}

/** Gather context. Stub stands in for a tool registry (kubectl, logs, dig). */
export async function gatherContext(alert: Alert): Promise<TriageContext> {
  return {
    signals: [
      `recent events for ${alert.source ?? "unknown source"}`,
      "no correlated incidents (stub)",
    ],
  };
}

/**
 * Propose a remediation. Stub by default; real Claude when ANTHROPIC_API_KEY is
 * set (and `@anthropic-ai/sdk` is installed).
 */
export async function proposeRemediation(input: {
  alert: Alert;
  classification: Classification;
  context: TriageContext;
}): Promise<Remediation> {
  if (process.env.ANTHROPIC_API_KEY) {
    return proposeWithClaude(input);
  }
  return {
    summary: `Proposed (stub): mitigate "${input.alert.title}" [${input.classification.severity}]`,
    risky: severityRisky(input.classification.severity),
  };
}

/**
 * Apply the remediation. Clearly stubbed — a real build would run the change
 * (kubectl, a runbook, an API call). The workflow calls this only once the
 * remediation is cleared (safe directly, risky after approval), so a held
 * remediation is never applied. This is the proposed-vs-executed boundary the
 * capstone is built to show.
 */
export async function applyRemediation(input: {
  alert: Alert;
  remediation: Remediation;
}): Promise<void> {
  console.log(`[alert-triage] ${input.alert.id}: applying (stub) — ${input.remediation.summary}`);
}

/** Post the outcome. Stub logs; a real build would post to Slack. */
export async function notifyOutcome(input: {
  alert: Alert;
  remediation: Remediation;
  approved: boolean;
  /** Whether `applyRemediation` actually ran (false → held at the gate). */
  applied: boolean;
}): Promise<void> {
  const status = input.applied
    ? input.remediation.risky
      ? "applied after approval"
      : "applied"
    : "held — not approved";
  console.log(`[alert-triage] ${input.alert.id}: ${input.remediation.summary} — ${status}`);
}

// ── Real-agent path (opt-in) ──────────────────────────────────────────────────

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
}

interface MinimalAnthropic {
  messages: {
    create(body: AnthropicRequest): Promise<AnthropicResponse>;
  };
}

/**
 * Parse the model's reply into a Remediation. Fails safe: a remediation is
 * `risky` (routes through the approval gate) unless the model explicitly ends
 * with SAFE *and* the response was not truncated. A truncated reply
 * (`stop_reason === "max_tokens"`) or any reply that does not clearly end in
 * SAFE is treated as risky — we never skip the gate on an ambiguous answer.
 */
export function parseRemediation(text: string, stopReason?: string | null): Remediation {
  const trimmed = text.trim();
  const summary = trimmed.replace(/\b(RISKY|SAFE)\s*$/i, "").trim();
  const truncated = stopReason === "max_tokens";
  const endsSafe = /\bSAFE\s*$/i.test(trimmed);
  return { summary: summary || trimmed, risky: truncated || !endsSafe };
}

async function proposeWithClaude(input: {
  alert: Alert;
  classification: Classification;
  context: TriageContext;
}): Promise<Remediation> {
  // Variable specifier keeps bundlers from resolving the optional dep when absent.
  const pkg = "@anthropic-ai/sdk";
  let Anthropic: new () => MinimalAnthropic;
  try {
    Anthropic = ((await import(pkg)) as { default: new () => MinimalAnthropic }).default;
  } catch (err) {
    // Only "module not found" means the optional dep is absent. Any other import
    // error (the package is present but fails to load) must surface its real cause.
    const code = (err as { code?: string }).code;
    if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        "ANTHROPIC_API_KEY is set but @anthropic-ai/sdk is not installed — run `npm i @anthropic-ai/sdk`.",
      );
    }
    throw err;
  }
  const client = new Anthropic();
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
  const prompt =
    `Alert: ${input.alert.title}\nSeverity: ${input.classification.severity}\n` +
    `Context: ${input.context.signals.join("; ")}\n\n` +
    `Propose a one-line remediation. End with RISKY or SAFE.`;
  let res: AnthropicResponse;
  try {
    res = await client.messages.create({
      model,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });
  } catch (err) {
    // 4xx (bad key, bad model, malformed request) will never succeed on retry —
    // fail the activity non-retryably so Temporal stops instead of masking the
    // cause as doomed retries. 5xx / network errors fall through to normal retry.
    const status = (err as { status?: number }).status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      throw ApplicationFailure.nonRetryable(
        `Anthropic API rejected the request (${status}): ${(err as Error).message}`,
        "AnthropicClientError",
      );
    }
    throw err;
  }
  const text = res.content.map((b) => b.text ?? "").join("");
  return withSeverityFloor(parseRemediation(text, res.stop_reason), input.classification.severity);
}
