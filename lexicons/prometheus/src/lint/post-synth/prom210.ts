/**
 * PROM210: A receiver integration or global setting is one Alertmanager rejects
 *
 * Two settings that exclude each other (a value and its *_file, a Slack api_url and app_token, Pushover html and monospace, two SNS targets), or a value outside the allowed set (WeChat message_type, Telegram parse_mode, Jira api_type, an Opsgenie responder type, a VictorOps reserved custom field, a smarthost that is not host:port, a Slack or Mattermost field without title and value).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { alertmanagerDiagnostics } from "./prom-helpers";

export const prom210: PostSynthCheck = {
  id: "PROM210",
  description: "A receiver integration or global setting is one Alertmanager rejects",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return alertmanagerDiagnostics(ctx, "PROM210");
  },
};
