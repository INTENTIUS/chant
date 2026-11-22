/**
 * ECS tasks as runtime nodes owned by their service (#5448).
 *
 * A Kubernetes Deployment shows the pods its controller made, each reported
 * with an `ownerChain` that reaches the declared Deployment, so the graph draws
 * them as `runtime` and a diff never proposes deleting them. An ECS service on
 * Fargate had nothing under it. This reads the tasks of each declared
 * `AWS::ECS::Service` the same way: `ListTasks` for the service, `DescribeTasks`
 * for what it listed, and each task reported with `ownerChain: { root:
 * "declared", entity: <the service's name> }`.
 *
 * A task says which task definition revision it runs and the service's own
 * current one, and `staleRevision` is true when they differ, which is what a
 * rolling deploy looks like. A service reports at most
 * {@link ECS_TASKS_PER_SERVICE_CAP} tasks, as the Kubernetes read caps what it
 * sweeps, and a note says when a service has more.
 *
 * Read only: `DescribeServices`, `ListTasks` and `DescribeTasks`. The calls go
 * through the read transport, so `AWS_ENDPOINT_URL` (Floci) answers them.
 */

import type { ResourceMetadata } from "@intentius/chant/lexicon";
import {
  AwsReadError,
  requestHeaders,
  serviceUrl,
  withChainCredentials,
  withEndpointOverride,
  type AwsReadClientOptions,
} from "./api/read-client";
import { clusterOfServiceArn, type AwsHealthHttp } from "./health";

/** The most tasks one service reports. `DescribeTasks` takes at most 100 per call, and a rolling deploy of a large service is read as its first 100. */
export const ECS_TASKS_PER_SERVICE_CAP = 100;

/** The resource type the tasks are reported as. */
export const ECS_TASK_TYPE = "AWS::ECS::Task";

/** A declared service whose tasks are read: the entity's name in the observation, and the service's ARN. */
export interface EcsServiceRef {
  entity: string;
  arn: string;
}

export interface EcsTasksOptions {
  client?: AwsReadClientOptions;
  http?: AwsHealthHttp;
  /** Tasks reported per service. Default {@link ECS_TASKS_PER_SERVICE_CAP}. */
  cap?: number;
}

export interface EcsTasksResult {
  /** The tasks as undeclared live resources, each owned by its service, keyed `Task/<cluster>/<task id>`. */
  resources: Record<string, ResourceMetadata>;
  /** One line for each service whose tasks were capped or could not be read. */
  notes: string[];
}

const defaultHttp: AwsHealthHttp = async (method, url, init) => {
  const res = await fetch(url, { method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
  return { status: res.status, text: await res.text() };
};

/** The revision a task definition ARN names: `arn:aws:ecs:<region>:<account>:task-definition/<family>:<revision>`. */
export function taskDefinitionRevision(arn: string | undefined): number | undefined {
  const m = /:(\d+)$/.exec(arn ?? "");
  return m ? Number(m[1]) : undefined;
}

/** The family a task definition ARN names. */
export function taskDefinitionFamily(arn: string | undefined): string | undefined {
  const m = /task-definition\/([^:]+)(?::\d+)?$/.exec(arn ?? "");
  return m?.[1];
}

async function ecsCall(
  target: string,
  payload: Record<string, unknown>,
  client: AwsReadClientOptions,
  http: AwsHealthHttp,
): Promise<Record<string, unknown>> {
  const options = await withChainCredentials(withEndpointOverride("ecs", client));
  const url = serviceUrl("ecs", options.endpoint, options.region);
  const body = JSON.stringify(payload);
  const headers = requestHeaders(
    "ecs",
    url,
    body,
    { "content-type": "application/x-amz-json-1.1", "x-amz-target": `AmazonEC2ContainerServiceV20141113.${target}` },
    options,
  );
  const res = await http("POST", url, { headers, body });
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(res.text);
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    throw new AwsReadError(`unparseable ${target} response`, res.status);
  }
  const errType = typeof parsed.__type === "string" ? parsed.__type.split("#").pop() : undefined;
  if (errType || res.status >= 400) {
    throw new AwsReadError(typeof parsed.message === "string" ? parsed.message : `${target} failed with HTTP ${res.status}`, res.status, errType);
  }
  return parsed;
}

interface EcsService {
  serviceArn?: string;
  serviceName?: string;
  taskDefinition?: string;
  deployments?: Array<{ status?: string; taskDefinition?: string }>;
}

interface EcsTask {
  taskArn?: string;
  taskDefinitionArn?: string;
  clusterArn?: string;
  lastStatus?: string;
  desiredStatus?: string;
  healthStatus?: string;
  launchType?: string;
  startedBy?: string;
  group?: string;
  availabilityZone?: string;
  createdAt?: number | string;
  startedAt?: number | string;
}

/** The task definition a service is rolling to: its primary deployment's, else its own. */
export function currentTaskDefinition(service: EcsService): string | undefined {
  return service.deployments?.find((d) => d.status === "PRIMARY")?.taskDefinition ?? service.taskDefinition;
}

/** An ECS timestamp (epoch seconds, or ISO text) as ISO text; empty when it has none. */
function iso(value: number | string | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  return value;
}

/** The task's own id: the last segment of its ARN. */
const taskId = (arn: string): string => arn.split("/").pop() ?? arn;

/** The service's name: the last segment of its ARN. */
const serviceName = (arn: string): string => arn.split("/").pop() ?? arn;

/**
 * The tasks of each service, reported as runtime nodes owned by it. A service
 * that cannot be read leaves a note, never a node, and does not stop the rest.
 */
export async function observeEcsTasks(services: readonly EcsServiceRef[], options: EcsTasksOptions = {}): Promise<EcsTasksResult> {
  const http = options.http ?? defaultHttp;
  const cap = Math.max(1, options.cap ?? ECS_TASKS_PER_SERVICE_CAP);
  const resources: Record<string, ResourceMetadata> = {};
  const notes: string[] = [];

  for (const ref of services) {
    const cluster = clusterOfServiceArn(ref.arn);
    const region = ref.arn.startsWith("arn:") ? ref.arn.split(":")[3] : undefined;
    const client: AwsReadClientOptions = { ...(options.client ?? {}), ...(region ? { region } : {}) };
    const name = serviceName(ref.arn);
    try {
      const described = await ecsCall("DescribeServices", { cluster, services: [ref.arn] }, client, http);
      const service = (Array.isArray(described.services) ? (described.services as EcsService[]) : [])[0];
      const current = service ? currentTaskDefinition(service) : undefined;

      // ListTasks pages by nextToken; stop once the cap is reached.
      const arns: string[] = [];
      let more = false;
      let nextToken: string | undefined;
      do {
        const page = await ecsCall(
          "ListTasks",
          { cluster, serviceName: name, maxResults: Math.min(100, cap + 1), ...(nextToken ? { nextToken } : {}) },
          client,
          http,
        );
        const found = Array.isArray(page.taskArns) ? (page.taskArns as string[]) : [];
        arns.push(...found);
        nextToken = typeof page.nextToken === "string" && page.nextToken ? page.nextToken : undefined;
      } while (nextToken && arns.length <= cap);
      if (arns.length > cap) {
        more = true;
        arns.length = cap;
      }
      if (more) notes.push(`[aws] ECS service ${name} has more than ${cap} tasks; the first ${cap} are reported`);
      if (arns.length === 0) continue;

      const tasks: EcsTask[] = [];
      for (let i = 0; i < arns.length; i += 100) {
        const out = await ecsCall("DescribeTasks", { cluster, tasks: arns.slice(i, i + 100) }, client, http);
        if (Array.isArray(out.tasks)) tasks.push(...(out.tasks as EcsTask[]));
      }
      const wanted = taskDefinitionRevision(current);
      for (const task of tasks) {
        if (!task.taskArn) continue;
        const revision = taskDefinitionRevision(task.taskDefinitionArn);
        const stale = current !== undefined && task.taskDefinitionArn !== undefined && task.taskDefinitionArn !== current;
        resources[`Task/${cluster}/${taskId(task.taskArn)}`] = {
          type: ECS_TASK_TYPE,
          physicalId: task.taskArn,
          status: task.lastStatus ?? "",
          lastUpdated: iso(task.startedAt ?? task.createdAt),
          // A task carries no chant marker of its own; its service is what declares it.
          ownership: "unknown",
          ownerChain: { root: "declared", entity: ref.entity },
          attributes: {
            cluster,
            service: name,
            lastStatus: task.lastStatus,
            desiredStatus: task.desiredStatus,
            ...(task.healthStatus ? { healthStatus: task.healthStatus } : {}),
            ...(task.launchType ? { launchType: task.launchType } : {}),
            ...(task.availabilityZone ? { availabilityZone: task.availabilityZone } : {}),
            ...(task.startedBy ? { startedBy: task.startedBy } : {}),
            taskDefinition: task.taskDefinitionArn,
            ...(taskDefinitionFamily(task.taskDefinitionArn) ? { taskDefinitionFamily: taskDefinitionFamily(task.taskDefinitionArn) } : {}),
            ...(revision !== undefined ? { taskDefinitionRevision: revision } : {}),
            ...(current ? { serviceTaskDefinition: current } : {}),
            ...(wanted !== undefined ? { serviceTaskDefinitionRevision: wanted } : {}),
            // True while a rolling deploy still has a task on an older revision than the service's current one.
            ...(current ? { staleRevision: stale } : {}),
          },
        } as ResourceMetadata;
      }
    } catch (err) {
      const detail = err instanceof AwsReadError && err.code ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
      notes.push(`[aws] the tasks of ECS service ${name} were not read: ${detail.slice(0, 200)}`);
    }
  }
  return { resources, notes };
}
