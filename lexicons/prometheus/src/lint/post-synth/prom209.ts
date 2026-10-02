/**
 * PROM209: A receiver integration is missing its destination or credential
 *
 * Every one of Alertmanager's 18 integrations is checked for the destination, credential and required fields its config validation asks for, with the global defaults it falls back to: e.g. a webhook url, an Opsgenie api_key (or global.opsgenie_api_key), a Telegram chat_id and bot token, a Webex room_id and authorization, an SNS target, a Jira project and issue_type.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { alertmanagerDiagnostics } from "./prom-helpers";

export const prom209: PostSynthCheck = {
  id: "PROM209",
  description: "A receiver integration is missing its destination or credential",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return alertmanagerDiagnostics(ctx, "PROM209");
  },
};
