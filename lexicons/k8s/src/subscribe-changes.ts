/**
 * The k8s change signal, `LexiconPlugin.subscribeChanges` (chant #1981).
 *
 * Kubernetes is the one substrate chant reaches where a change stream is
 * complete, trustworthy, and needs nothing deployed into the cluster being
 * observed: the Watch API is served for every kind the API server serves, is
 * `resourceVersion`-based so a reconnect has a defined resume point, and is
 * authorized by the same read credentials `describeResources` already uses.
 * Every cloud substrate fails on that last point. Subscribing to EventBridge,
 * Cloud Asset Inventory or Event Grid means writing infrastructure into the
 * account being watched, which inverts the property that makes a read-only
 * watch safe to point at production. The verdict table in the operator guide
 * records that per lexicon; this file is the one place it came out `yes`.
 *
 * ## What this is allowed to conclude: nothing
 *
 * A watch event never becomes an observation. The frames are read, and then
 * discarded. The only thing that leaves this module is a no-argument
 * `onChange()`, which wakes an operator tick that re-observes the estate from
 * scratch through the ordinary read path. There is no code here that could
 * turn a `DELETED` frame into a proposed `create`, because there is no channel
 * from a frame to anything but a function call with no parameters.
 *
 * That is also why a missed event costs nothing. A `410 Gone`, a dropped
 * connection, a subscription that never got established: all of them slow
 * detection back to the operator's timer, and none of them make the estate
 * read as clean.
 *
 * ## Scope
 *
 * One watch per (kind, namespace) the declared entities name. The kinds come
 * from the same generated operation surface `describeResources` addresses
 * entities through; the namespaces come from the declarations themselves,
 * falling back to the client's own default for a namespaced entity that
 * declares none. Nothing widens that: a project declaring three Deployments in
 * one namespace opens one connection, not a cluster-wide firehose.
 */

import type { ChangeSubscription, SubscribeChangesOptions } from "@intentius/chant/lexicon";
import type { K8sClient, WatchHandle } from "@intentius/chant-k8s-client";
import { defaultK8sConnector, type K8sConnector } from "./api/connect";
import { operationFor } from "./api/operation-surface";

/**
 * The most connections one subscription will hold open.
 *
 * A watch is a long-lived HTTP/2 stream against the API server, and one per
 * (kind, namespace) is cheap right up until an estate declares eighty kinds
 * across a dozen namespaces. Past this ceiling the honest move is to refuse
 * the whole subscription and say so, rather than to open some arbitrary
 * prefix of it: a partial watch is a signal that goes quiet for exactly the
 * resources nobody chose to drop. The operator then runs on its timer, which
 * is what it did before this existed.
 */
export const MAX_WATCHES = 32;

/** One thing to watch: a kind, and the namespace to watch it in. */
interface WatchTarget {
  apiVersion: string;
  kind: string;
  /** Absent for a cluster-scoped kind. */
  namespace?: string;
}

/**
 * The distinct (kind, namespace) pairs a declared estate implies.
 *
 * Deterministic order, so a refusal past {@link MAX_WATCHES} names the same
 * scope every time and a test can assert on it.
 */
export function watchTargets(
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>,
  defaultNamespace: string,
): { targets: WatchTarget[]; unaddressable: string[] } {
  const byKey = new Map<string, WatchTarget>();
  const unaddressable = new Set<string>();

  for (const [, entity] of entities) {
    const operation = operationFor(entity.entityType);
    if (!operation) {
      // chant knows no API address for this type, the same hole
      // `describeResources` reports as `unsupported-kind`. Nothing to watch,
      // and never a reason to widen to something else.
      unaddressable.add(entity.entityType);
      continue;
    }
    const declared = (entity.props.metadata as { namespace?: string } | undefined)?.namespace;
    const namespace =
      operation.scope === "Namespaced" ? (declared ?? defaultNamespace) : undefined;
    const key = `${operation.apiVersion}|${operation.kind}|${namespace ?? ""}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        apiVersion: operation.apiVersion,
        kind: operation.kind,
        ...(namespace ? { namespace } : {}),
      });
    }
  }

  return {
    targets: [...byKey.values()].sort((a, b) =>
      `${a.apiVersion}|${a.kind}|${a.namespace ?? ""}`.localeCompare(
        `${b.apiVersion}|${b.kind}|${b.namespace ?? ""}`,
      ),
    ),
    unaddressable: [...unaddressable].sort(),
  };
}

/** Human phrasing of one target, for a log line. */
function targetText(target: WatchTarget): string {
  return `${target.apiVersion} ${target.kind}${target.namespace ? ` in ${target.namespace}` : ""}`;
}

/**
 * Open one watch per declared (kind, namespace) and report every event as a
 * bare `onChange()`.
 *
 * Throws only for a failure that makes the whole subscription impossible: no
 * entities in scope, a cluster binding that will not resolve, a scope past the
 * ceiling. The operator turns that into one logged line and keeps polling.
 * Once the subscription is live, nothing throws: a watch that dies reports
 * through `onError` and the operator re-subscribes on its next round.
 */
export async function subscribeChanges(
  options: SubscribeChangesOptions,
  connect: K8sConnector = defaultK8sConnector,
): Promise<ChangeSubscription> {
  const entities = options.entities;
  if (!entities || entities.size === 0) {
    throw new Error(
      "no declared k8s entities in scope. A change signal watches what the project declares, and there is nothing to watch",
    );
  }

  // The same connect path the read takes, so the cluster a signal comes from
  // is the cluster a tick would read. A binding that refuses, refuses here.
  const { client }: { client: K8sClient } = await connect({
    environment: options.environment,
    cwd: options.cwd,
  });

  const { targets, unaddressable } = watchTargets(entities, client.defaultNamespace);
  if (unaddressable.length > 0) {
    // A hole in the signal, reported the way a hole in an observation is:
    // named, not swallowed. The timer still covers these kinds.
    options.onError?.(
      `no API address for ${unaddressable.join(", ")}, so changes to those kinds are found on the timer alone`,
    );
  }
  if (targets.length === 0) {
    throw new Error("no watchable k8s kinds among the declared entities");
  }
  if (targets.length > MAX_WATCHES) {
    throw new Error(
      `the declared estate needs ${targets.length} watch connections, past the ${MAX_WATCHES} ceiling, so it is ` +
        "running on the operator's timer rather than opening a partial watch that would go quiet for the rest",
    );
  }

  const handles: WatchHandle[] = [];
  /** Reported once for the whole subscription: the operator re-subscribes as a whole. */
  let reported = false;
  const reportOnce = (message: string) => {
    if (reported) return;
    reported = true;
    options.onError?.(message);
  };

  const stopOnAbort = () => {
    void closeAll();
  };
  let closing: Promise<void> | undefined;
  const closeAll = (): Promise<void> => {
    if (!closing) {
      options.signal.removeEventListener("abort", stopOnAbort);
      const open = handles.splice(0, handles.length);
      closing = Promise.allSettled(open.map((h) => h.close())).then(() => undefined);
    }
    return closing;
  };

  try {
    for (const target of targets) {
      handles.push(
        await client.watch(
          { apiVersion: target.apiVersion, kind: target.kind },
          {
            ...(target.namespace ? { namespace: target.namespace } : {}),
            signal: options.signal,
            // The whole consumption of a watch event, in one line: it happened,
            // so look again. The frame is not read, not stored, not passed on.
            onEvent: () => options.onChange(),
            onError: (message) => reportOnce(`watch on ${targetText(target)} ended: ${message}`),
          },
        ),
      );
    }
  } catch (err) {
    // A partial open is not a subscription. Unwind what did open, and let the
    // operator report one failure and keep its timer.
    await closeAll();
    throw err;
  }

  if (options.signal.aborted) await closeAll();
  else options.signal.addEventListener("abort", stopOnAbort, { once: true });

  return { close: closeAll };
}
