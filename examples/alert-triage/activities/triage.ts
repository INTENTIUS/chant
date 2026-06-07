// Triage activities — plain async functions the Temporal worker registers.
//
// These are raw Temporal activities (not chant Op steps): the triage workflow is
// custom app logic, so it's hand-written Temporal with chant synthesizing the
// manifests around it. See chant's "Raw Temporal + chant" deployment path.
//
// The agent is stubbed by default — deterministic, no key, runs in CI and
// offline. When ANTHROPIC_API_KEY is set, `proposeRemediation` calls Claude.

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
  const risky =
    input.classification.severity === "high" ||
    input.classification.severity === "critical";
  return {
    summary: `Proposed (stub): mitigate "${input.alert.title}" [${input.classification.severity}]`,
    risky,
  };
}

/** Post the outcome. Stub logs; a real build would post to Slack. */
export async function notifyOutcome(input: {
  alert: Alert;
  remediation: Remediation;
  approved: boolean;
}): Promise<void> {
  const status = input.remediation.risky
    ? input.approved
      ? "applied after approval"
      : "held — not approved"
    : "applied";
  console.log(`[alert-triage] ${input.alert.id}: ${input.remediation.summary} — ${status}`);
}

// ── Real-agent path (opt-in) ──────────────────────────────────────────────────

interface MinimalAnthropic {
  messages: {
    create(body: unknown): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
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
  } catch {
    throw new Error(
      "ANTHROPIC_API_KEY is set but @anthropic-ai/sdk is not installed — run `npm i @anthropic-ai/sdk`.",
    );
  }
  const client = new Anthropic();
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
  const prompt =
    `Alert: ${input.alert.title}\nSeverity: ${input.classification.severity}\n` +
    `Context: ${input.context.signals.join("; ")}\n\n` +
    `Propose a one-line remediation. End with RISKY or SAFE.`;
  const res = await client.messages.create({
    model,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });
  const text = res.content.map((b) => b.text ?? "").join("").trim();
  return { summary: text.replace(/\b(RISKY|SAFE)\s*$/i, "").trim(), risky: /RISKY\s*$/i.test(text) };
}
