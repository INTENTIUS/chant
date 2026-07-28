/**
 * `chant kube logs` (chant #1079) — a Pod's `/log` subresource, over the
 * typed client's new `readLog` (`packages/k8s-client/src/client.ts`). A
 * snapshot only: `--follow`/`-f` would need the transport seam to expose a
 * stream rather than a completed response body, which it does not today —
 * left out deliberately (see `readLog`'s own doc) rather than faked with a
 * poll loop that isn't actually following anything.
 */

import { formatUnobserved } from "@intentius/chant/observation";
import { defaultK8sConnector, type K8sConnector } from "../api/connect";
import { classifyApiFailure } from "../api/classify";
import { operationFor } from "../api/operation-surface";
import { kubeConnect } from "./connect";
import { parseKubeFlags, connectOptionsFrom, parseDurationSeconds } from "./flags";
import { loadKubeProjectContext, type KubeProjectContext } from "./project";

export interface LogsDeps {
  connect?: K8sConnector;
  loadProject?: (cwd?: string) => Promise<KubeProjectContext | undefined>;
}

export async function runLogs(rawArgs: string[], deps: LogsDeps = {}): Promise<number> {
  const connect = deps.connect ?? defaultK8sConnector;
  const loadProject = deps.loadProject ?? loadKubeProjectContext;

  let flags;
  try {
    flags = parseKubeFlags(rawArgs, {
      value: { "-c": "container", "--container": "container", "--tail": "tail", "--since": "since" },
      boolean: { "-p": "previous", "--previous": "previous", "--timestamps": "timestamps" },
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const podArg = flags.positional[0];
  if (!podArg) {
    console.error("error: a pod name (or a declared entity name) is required — e.g. `chant kube logs web-6c8f`");
    return 1;
  }

  const project = await loadProject();
  let podName = podArg;
  let namespace = flags.values.namespace;
  const entity = project?.entities.get(podArg);
  if (entity && entity.lexicon === "k8s") {
    const operation = operationFor(entity.entityType);
    if (operation && operation.kind !== "Pod") {
      console.error(`error: "${podArg}" declares a ${operation.kind}, not a Pod — chant kube logs only reads Pod logs`);
      return 1;
    }
    if (operation?.kind === "Pod") {
      const props = "props" in entity ? ((entity as { props: unknown }).props as Record<string, unknown>) : undefined;
      const metadata = props?.metadata as { name?: string; namespace?: string } | undefined;
      if (metadata?.name) {
        podName = metadata.name;
        namespace = namespace ?? metadata.namespace;
      }
    }
  }

  const connected = await kubeConnect(connectOptionsFrom(flags.values), connect);
  if (connected.kind === "unobserved") {
    console.error(formatUnobserved(`pod/${podName}`, { reason: connected.reason, detail: connected.detail }));
    return 1;
  }
  const { client } = connected;

  const tailLines = flags.values.tail !== undefined ? Number(flags.values.tail) : undefined;
  const sinceSeconds = flags.values.since !== undefined ? parseDurationSeconds(flags.values.since) : undefined;

  try {
    const text = await client.readLog(
      { apiVersion: "v1", kind: "Pod", name: podName, namespace: namespace ?? client.defaultNamespace },
      {
        ...(flags.values.container ? { container: flags.values.container } : {}),
        ...(tailLines !== undefined ? { tailLines } : {}),
        ...(sinceSeconds !== undefined ? { sinceSeconds } : {}),
        previous: flags.flags.previous ?? false,
        timestamps: flags.flags.timestamps ?? false,
      },
    );
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return 0;
  } catch (err) {
    const outcome = classifyApiFailure(err);
    if (outcome.kind === "absent") {
      console.error(`Error from server (NotFound): pods "${podName}" not found`);
      return 1;
    }
    console.error(formatUnobserved(`pod/${podName}`, { reason: outcome.reason, detail: outcome.detail }));
    return 1;
  }
}
