import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { OpConfig } from "../../op/types";
import type { WorkflowExecutionDescription, WorkflowHistoryRaw, HistoryEvent } from "./run-client";

interface ActivityRecord {
  name: string;
  startTime?: Date;
  endTime?: Date;
  durationMs?: number;
  status: "completed" | "failed" | "running";
  error?: string;
}

interface PhaseRecord {
  name: string;
  activities: ActivityRecord[];
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function extractPhaseRecords(config: OpConfig, history: WorkflowHistoryRaw): PhaseRecord[] {
  const events = history.events ?? [];

  // Build map: scheduled event ID → activity name
  const scheduledActivities = new Map<string, string>();
  const scheduledTimes = new Map<string, Date>();
  const completedTimes = new Map<string, Date>();
  const failedActivities = new Map<string, string>();

  for (const event of events) {
    if (event.eventType === "ActivityTaskScheduled" && event.activityTaskScheduledEventAttributes) {
      const attrs = event.activityTaskScheduledEventAttributes;
      const id = String(attrs.activityId ?? "");
      const name = attrs.activityType?.name ?? "unknown";
      scheduledActivities.set(id, name);
      if (event.eventTime) scheduledTimes.set(id, new Date(event.eventTime));
    }
    if (event.eventType === "ActivityTaskCompleted" && event.activityTaskCompletedEventAttributes) {
      const scheduledId = String(event.activityTaskCompletedEventAttributes.scheduledEventId ?? "");
      if (event.eventTime) completedTimes.set(scheduledId, new Date(event.eventTime));
    }
    if (event.eventType === "ActivityTaskFailed" && event.activityTaskFailedEventAttributes) {
      const msg = event.activityTaskFailedEventAttributes.failure?.message ?? "unknown error";
      failedActivities.set(String(events.indexOf(event)), msg);
    }
  }

  return config.phases.map((phase) => {
    const activities: ActivityRecord[] = phase.steps
      .filter((s) => s.kind === "activity")
      .map((step) => {
        if (step.kind !== "activity") return null;
        const fn = step.fn;
        // Find this activity by name in the history
        let record: ActivityRecord | null = null;
        for (const [id, name] of scheduledActivities) {
          if (name === fn) {
            const start = scheduledTimes.get(id);
            const end = completedTimes.get(id);
            const durationMs = start && end ? end.getTime() - start.getTime() : undefined;
            record = {
              name: fn,
              startTime: start,
              endTime: end,
              durationMs,
              status: end ? "completed" : "running",
            };
          }
        }
        return record ?? { name: fn, status: "running" };
      })
      .filter((r): r is ActivityRecord => r !== null);

    return { name: phase.name, activities };
  });
}

export function generateReport(
  opName: string,
  config: OpConfig,
  description: WorkflowExecutionDescription,
  history: WorkflowHistoryRaw,
): string {
  const lines: string[] = [];

  const status = description.status.name;
  const startTime = description.startTime;
  const closeTime = description.closeTime;
  const durationMs = closeTime ? closeTime.getTime() - startTime.getTime() : undefined;

  lines.push(`# Deployment Report: ${opName}`);
  lines.push("");
  lines.push("## Overview");
  lines.push("");
  lines.push(`| Field | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Op | ${opName} |`);
  lines.push(`| Overview | ${config.overview} |`);
  lines.push(`| Status | **${status}** |`);
  lines.push(`| Workflow ID | ${description.workflowId} |`);
  lines.push(`| Run ID | ${description.runId} |`);
  lines.push(`| Start | ${startTime.toISOString()} |`);
  if (closeTime) lines.push(`| End | ${closeTime.toISOString()} |`);
  if (durationMs !== undefined) lines.push(`| Duration | ${formatDuration(durationMs)} |`);
  lines.push("");

  lines.push("## Timeline");
  lines.push("");
  lines.push("| Phase | Activity | Duration | Status |");
  lines.push("|---|---|---|---|");

  const phases = extractPhaseRecords(config, history);
  for (const phase of phases) {
    if (phase.activities.length === 0) {
      lines.push(`| ${phase.name} | — | — | — |`);
    }
    for (const act of phase.activities) {
      const dur = act.durationMs !== undefined ? formatDuration(act.durationMs) : "—";
      const statusEmoji = act.status === "completed" ? "✓" : act.status === "failed" ? "✗" : "…";
      lines.push(`| ${phase.name} | ${act.name} | ${dur} | ${statusEmoji} ${act.status} |`);
    }
  }
  lines.push("");

  // Errors section
  const failedEvents = (history.events ?? []).filter(
    (e): e is HistoryEvent & Required<Pick<HistoryEvent, "activityTaskFailedEventAttributes">> =>
      e.eventType === "ActivityTaskFailed" && !!e.activityTaskFailedEventAttributes,
  );

  if (failedEvents.length > 0) {
    lines.push("## Errors");
    lines.push("");
    for (const event of failedEvents) {
      const msg = event.activityTaskFailedEventAttributes?.failure?.message ?? "unknown";
      lines.push(`- ${msg}`);
    }
    lines.push("");
  }

  lines.push(`---`);
  lines.push(`*Generated by chant at ${new Date().toISOString()}*`);
  lines.push("");

  return lines.join("\n");
}

export function writeReport(opName: string, markdown: string): string {
  const outPath = join("dist", `${opName}-report.md`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, "utf-8");
  return outPath;
}
