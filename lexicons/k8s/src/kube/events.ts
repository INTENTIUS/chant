/**
 * `chant kube events` (chant #1079) — the core `v1 Event` kind is addressed
 * exactly like any other read (`client.list`), no client extension needed.
 * The one thing the typed client's `ListOptions` does not carry is a field
 * selector, so `--for <kind>/<name>` (kubectl's own `kubectl events
 * --for=kind/name` shape) filters client-side against `involvedObject` after
 * the list comes back, rather than asking the server to. Event volume in a
 * single namespace is small enough that this is a fine trade for not
 * widening the client's surface for one caller.
 */

import type { K8sClient, K8sObject } from "@intentius/chant-k8s-client";
import { formatUnobserved } from "@intentius/chant/observation";
import { defaultK8sConnector, type K8sConnector } from "../api/connect";
import { classifyApiFailure } from "../api/classify";
import { kubeConnect } from "./connect";
import { parseKubeFlags, connectOptionsFrom } from "./flags";
import { renderTable, renderJson, renderYaml, relativeAge, parseOutput } from "./render";

export interface EventsDeps {
  connect?: K8sConnector;
}

interface InvolvedObject {
  kind?: string;
  name?: string;
  namespace?: string;
}

function involvedOf(event: K8sObject): InvolvedObject {
  return (event.involvedObject as InvolvedObject | undefined) ?? {};
}

function eventTimestamp(event: K8sObject): string | undefined {
  return (
    (event.lastTimestamp as string | undefined) ??
    (event.eventTime as string | undefined) ??
    event.metadata?.creationTimestamp
  );
}

/** Events whose `involvedObject` names `ref`, oldest first — kubectl's own default order. */
export function filterInvolved(events: readonly K8sObject[], ref: { kind: string; name: string }): K8sObject[] {
  return events.filter((e) => {
    const involved = involvedOf(e);
    return involved.kind === ref.kind && involved.name === ref.name;
  });
}

function sortByTime(events: readonly K8sObject[]): K8sObject[] {
  return [...events].sort((a, b) => {
    const ta = eventTimestamp(a);
    const tb = eventTimestamp(b);
    if (!ta && !tb) return 0;
    if (!ta) return -1;
    if (!tb) return 1;
    return Date.parse(ta) - Date.parse(tb);
  });
}

/**
 * List Events for `namespace` (or every namespace, when `namespace` is
 * undefined), sorted oldest first. Shared by `runEvents` and `describe`'s own
 * Events section, so the two verbs agree on what "the events for this object"
 * means.
 */
export async function listEvents(
  client: K8sClient,
  options: { namespace?: string; labelSelector?: string } = {},
): Promise<K8sObject[]> {
  const events = await client.list(
    { apiVersion: "v1", kind: "Event" },
    { ...(options.namespace ? { namespace: options.namespace } : {}), ...(options.labelSelector ? { labelSelector: options.labelSelector } : {}) },
  );
  return sortByTime(events);
}

function eventRow(e: K8sObject): string[] {
  const involved = involvedOf(e);
  const count = typeof e.count === "number" ? e.count : undefined;
  return [
    relativeAge(eventTimestamp(e)),
    (e.type as string | undefined) ?? "",
    (e.reason as string | undefined) ?? "",
    `${involved.kind ?? ""}/${involved.name ?? ""}`,
    `${(e.message as string | undefined) ?? ""}${count && count > 1 ? ` (x${count})` : ""}`,
  ];
}

/** Render an events table — reused by `describe`'s Events section. */
export function renderEvents(events: readonly K8sObject[]): string {
  if (events.length === 0) return "No events found.";
  return renderTable(["LAST SEEN", "TYPE", "REASON", "OBJECT", "MESSAGE"], events.map(eventRow));
}

function parseFor(value: string | undefined): { kind: string; name: string } | undefined {
  if (!value) return undefined;
  const slash = value.indexOf("/");
  if (slash === -1) throw new Error(`--for expects KIND/NAME, e.g. --for=Pod/web-abc123`);
  return { kind: value.slice(0, slash), name: value.slice(slash + 1) };
}

export async function runEvents(rawArgs: string[], deps: EventsDeps = {}): Promise<number> {
  const connect = deps.connect ?? defaultK8sConnector;

  let flags;
  try {
    flags = parseKubeFlags(rawArgs, { value: { "--for": "for" } });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let output;
  let forRef;
  try {
    output = parseOutput(flags.values.output);
    forRef = parseFor(flags.values.for);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const connected = await kubeConnect(connectOptionsFrom(flags.values), connect);
  if (connected.kind === "unobserved") {
    console.error(formatUnobserved("events", { reason: connected.reason, detail: connected.detail }));
    return 1;
  }
  const { client } = connected;

  const namespace = flags.flags.allNamespaces ? undefined : (flags.values.namespace ?? client.defaultNamespace);

  let events: K8sObject[];
  try {
    events = await listEvents(client, { namespace, ...(flags.values.selector ? { labelSelector: flags.values.selector } : {}) });
  } catch (err) {
    const outcome = classifyApiFailure(err);
    console.error(
      formatUnobserved("events", {
        reason: outcome.kind === "unobserved" ? outcome.reason : "read-failed",
        detail: outcome.kind === "unobserved" ? outcome.detail : String(err),
      }),
    );
    return 1;
  }

  if (forRef) events = filterInvolved(events, forRef);

  switch (output.kind) {
    case "json":
      console.log(renderJson(events));
      return 0;
    case "yaml":
      console.log(renderYaml(events));
      return 0;
    default:
      console.log(renderEvents(events));
      return 0;
  }
}
