/**
 * Events covering every line chant's Slack and Teams messages write (#4818).
 * `messages.json` beside this holds what chant 0.124.77 rendered for each,
 * with and without relay buttons, so a message given no words stays byte for
 * byte as it was.
 */
import { makeNotifyEvent, type NotifyEvent } from "../../notify";

const NOW = new Date("2026-10-11T12:00:00.000Z");
const DIGEST = "jcs1-sha256:" + "a".repeat(64);
const run = { url: "https://github.com/acme/db/actions/runs/42", forge: "github" as const, repository: "acme/db", commit: "abc123" };
const at = (fields: Parameters<typeof makeNotifyEvent>[0]): NotifyEvent => makeNotifyEvent(fields, { env: {}, now: NOW });

export const NOTIFY_MESSAGE_EVENTS: Record<string, NotifyEvent> = {
  waiting: at({ source: "chant", event: "waiting", summary: "", project: "acme/db", wave: { number: 2, name: "prod", gate: "wave-2" }, targets: ["net", "app"], digest: DIGEST, approve: { command: `chant approve tf-apply wave-2 --plan ${DIGEST}` }, run, reportUrl: "https://reports.example/42" }),
  review: at({ source: "chant", event: "waiting", summary: "wave 2 waits", wave: { number: 2, gate: "wave-2" }, targets: ["net"], digest: DIGEST, approve: { command: "chant approve tf-apply wave-2", review: { pr: 7, url: "https://github.com/acme/db/pull/7/files" } }, run }),
  refused: at({ source: "sql-yodeler", event: "refused", summary: "", project: "acme/db", environment: "prod", targets: [], reason: "the plan moved after approval", exitCode: 4 }),
  failed: at({ source: "plywood", event: "failed", summary: "shop-prod failed", targets: ["shop-prod"], reason: "pulumi up exited 255", run: { url: "https://gitlab.com/acme/db/-/jobs/9" } }),
  drift: at({ source: "chant", event: "drift", summary: "2 members drifted: net, app", targets: ["net", "app"], drift: { changed: ["net", "app"], missing: ["db"], failed: ["dns"], fingerprint: "f1" }, run, reportUrl: "https://reports.example/43" }),
  driftNone: at({ source: "chant", event: "drift", summary: "no members drifted", targets: [], drift: { changed: [], failed: ["dns"] } }),
  ciRed: at({ source: "chant", event: "ci.red", summary: "", project: "acme/db", targets: [], ci: { branch: "main", commit: "0123456789abcdef", phase: "test", failedRun: { name: "unit", id: 5, conclusion: "failure", url: "https://github.com/acme/db/actions/runs/5" } } }),
  ciGreen: at({ source: "chant", event: "ci.green", summary: "", project: "acme/db", targets: [], ci: { branch: "main", commit: "fedcba9876543210", red: "0123456789abcdef", culprit: "aaaabbbbccccdddd" } }),
};
