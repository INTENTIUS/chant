/**
 * terragucci's own Slack and Teams bodies, copied unchanged from
 * packages/terragucci/src/notify.ts at terragucci commit c87473035270
 * (origin/main, 2026-11-08), for #4818. chant's messages under terragucci's
 * words must come out byte for byte as these do; once terragucci renders
 * through chant's, it deletes the originals.
 *
 * Written here: the imports, `NOTIFY_SOURCE`, the notice types without the
 * fields the renderers do not read, and `export` on `summary`. Every function
 * body is terragucci's.
 */
import { slackRelayActions, teamsRelayReply, type RelayButtons } from "../notify";

const NOTIFY_SOURCE = "terragucci";
export const REPLAN_ACTION = "terragucci-replan";
type WaveEvent = "waiting" | "refused" | "failed";

export interface WaveNotice {
  event: WaveEvent;
  wave: number;
  project: string;
  roots: string[];
  approve: string;
  digest?: string;
  review?: { pr: number; url: string };
  outcome?: string;
  run?: string;
  report?: string;
  relay?: string;
}

export interface DriftNotice {
  project: string;
  roots: string[];
  failed: string[];
  run?: string;
  report?: string;
  replan?: string;
}

const HEADLINE: Record<WaveEvent, string> = {
  waiting: "waits for an approval",
  refused: "was refused: its plans changed after approval, so nothing in it was applied",
  failed: "failed",
};

/** What happened to the wave: the first line, after `terragucci: `. */
export const summary = (n: WaveNotice): string => `wave ${n.wave} of ${n.project} ${HEADLINE[n.event]}`;

/** The first line of every message. */
export function headline(n: WaveNotice): string {
  return `${NOTIFY_SOURCE}: ${summary(n)}`;
}

const rootsText = (n: WaveNotice): string => (n.roots.length > 0 ? n.roots.join(", ") : "see the run");

/** A Slack button. `url` makes it a link that opens a page. */
function slackButton(text: string, action: string, o: { value?: string; url?: string; style?: "primary" | "danger" }): Record<string, unknown> {
  return { type: "button", action_id: action, text: { type: "plain_text", text }, ...(o.value ? { value: o.value } : {}), ...(o.url ? { url: o.url } : {}), ...(o.style ? { style: o.style } : {}) };
}

/**
 * A Slack incoming webhook's body: one mrkdwn text. With the relay's signed
 * button value (`relay`, which chant's sendNotify passes for a waiting wave
 * when the relay key is set), the text as a block and chant's Approve and
 * Decline buttons.
 */
export function slackMessage(n: WaveNotice, relay?: RelayButtons): { text: string; blocks?: Record<string, unknown>[] } {
  const text = slackText(n);
  if (!n.relay || !relay || n.event !== "waiting") return { text };
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }, slackRelayActions(relay)] };
}

function slackText(n: WaveNotice): string {
  return [
      `*${headline(n)}*`,
      ...(n.review ? [`Review and approve: <${n.review.url}|pull request ${n.review.pr}>, then run the wave again`] : []),
      `Roots: ${rootsText(n)}`,
      ...(n.digest ? [`Digest: \`${n.digest}\``] : []),
      `${n.review ? "Or approve" : "Approve"}: \`${n.approve}\``,
      ...(n.outcome ? [`Outcome: ${n.outcome}`] : []),
      ...(n.run ? [`Run: <${n.run}>`] : []),
      ...(n.report ? [`Report: <${n.report}>`] : []),
    ].join("\n");
}

/** The Teams reply that approves or declines a waiting wave through the relay's outgoing webhook: a mention of the relay, then chant's reply. */
export const teamsReply = (n: Pick<WaveNotice, "relay">, relay: RelayButtons, action: "approve" | "decline"): string => `@${n.relay} ${teamsRelayReply(relay, action)}`;

/** A Teams incoming webhook's body (a Workflows webhook): one Adaptive Card. Its actions open the pull request's review page, under pr-review, and the run. */
export function teamsMessage(n: WaveNotice, relay?: RelayButtons): Record<string, unknown> {
  const facts = [
    { title: "Wave", value: String(n.wave) },
    ...(n.review ? [{ title: "Review and approve", value: `pull request ${n.review.pr}, then run the wave again: ${n.review.url}` }] : []),
    { title: "Roots", value: rootsText(n) },
    ...(n.digest ? [{ title: "Digest", value: n.digest }] : []),
    { title: n.review ? "Or approve" : "Approve", value: n.approve },
    ...(n.outcome ? [{ title: "Outcome", value: n.outcome }] : []),
    ...(n.run ? [{ title: "Run", value: n.run }] : []),
  ];
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: headline(n), weight: "Bolder", wrap: true },
            { type: "FactSet", facts },
            // Teams has no button that reaches a relay without a registered bot, so the card gives the reply its outgoing webhook reads.
            ...(n.relay && relay && n.event === "waiting"
              ? [{ type: "TextBlock", wrap: true, text: `Approve here: reply ${teamsReply(n, relay, "approve")}. Decline: reply ${teamsReply(n, relay, "decline")}.` }]
              : []),
          ],
          ...(n.review || n.run ? { actions: [...(n.review ? [{ type: "Action.OpenUrl", title: "Review and approve", url: n.review.url }] : []), ...(n.run ? [{ type: "Action.OpenUrl", title: "Open the run", url: n.run }] : [])] } : {}),
        },
      },
    ],
  };
}

export const driftHeadline = (n: DriftNotice): string =>
  `terragucci: drift in ${n.project}: ${n.roots.length > 0 ? `${n.roots.length} root${n.roots.length === 1 ? "" : "s"} changed outside Terraform` : "no drift found"}${n.failed.length > 0 ? `, ${n.failed.length} could not be refreshed` : ""}`;

/** The drift notice for Slack: the text, and a Re-plan button that opens the page where the check runs again. */
export function slackDrift(n: DriftNotice): { text: string; blocks?: Record<string, unknown>[] } {
  const text = [
    `*${driftHeadline(n)}*`,
    ...(n.roots.length > 0 ? [`Drifted: ${n.roots.join(", ")}`] : []),
    ...(n.failed.length > 0 ? [`Not refreshed: ${n.failed.join(", ")}`] : []),
    ...(n.run ? [`Run: <${n.run}>`] : []),
    ...(n.report ? [`Report: <${n.report}>`] : []),
  ].join("\n");
  if (!n.replan) return { text };
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }, { type: "actions", block_id: "terragucci-drift", elements: [slackButton("Re-plan", REPLAN_ACTION, { url: n.replan })] }] };
}

/** The drift notice for Teams: an Adaptive Card whose Re-plan button opens the page where the check runs again. */
export function teamsDrift(n: DriftNotice): Record<string, unknown> {
  const facts = [
    ...(n.roots.length > 0 ? [{ title: "Drifted", value: n.roots.join(", ") }] : []),
    ...(n.failed.length > 0 ? [{ title: "Not refreshed", value: n.failed.join(", ") }] : []),
    ...(n.run ? [{ title: "Run", value: n.run }] : []),
  ];
  const actions = [...(n.replan ? [{ type: "Action.OpenUrl", title: "Re-plan", url: n.replan }] : []), ...(n.run ? [{ type: "Action.OpenUrl", title: "Open the run", url: n.run }] : [])];
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: driftHeadline(n), weight: "Bolder", wrap: true },
            { type: "FactSet", facts },
          ],
          ...(actions.length > 0 ? { actions } : {}),
        },
      },
    ],
  };
}

