import { describe, expect, test } from "vitest";
import {
  clusterOfServiceArn,
  ecsServiceEntry,
  healthCheckEntry,
  observeHealthAws,
  parseHealthCheckStatus,
  type AwsHealthHttp,
} from "./health";
import type { AwsReadHttp } from "./api/read-client";
import { awsPlugin } from "./plugin";

const AT = "2026-10-20T21:00:00.000Z";
const now = () => new Date(AT);

function stackXml(members: Array<{ logical: string; type: string; physical: string }>): string {
  const body = members
    .map((m) => `<member><LogicalResourceId>${m.logical}</LogicalResourceId><ResourceType>${m.type}</ResourceType><PhysicalResourceId>${m.physical}</PhysicalResourceId><ResourceStatus>CREATE_COMPLETE</ResourceStatus></member>`)
    .join("");
  return `<DescribeStackResourcesResponse><DescribeStackResourcesResult><StackResources>${body}</StackResources></DescribeStackResourcesResult></DescribeStackResourcesResponse>`;
}

function statusXml(obs: Array<{ region: string; status: string; time: string }>): string {
  const body = obs
    .map((o) => `<HealthCheckObservation><Region>${o.region}</Region><IPAddress>1.2.3.4</IPAddress><StatusReport><Status>${o.status}</Status><CheckedTime>${o.time}</CheckedTime></StatusReport></HealthCheckObservation>`)
    .join("");
  return `<GetHealthCheckStatusResponse><HealthCheckObservations>${body}</HealthCheckObservations></GetHealthCheckStatusResponse>`;
}

const ENV = { AWS_ENDPOINT_URL: "http://localhost:4566" };

describe("aws health (#4177)", () => {
  test("parses checker observations", () => {
    const obs = parseHealthCheckStatus(statusXml([{ region: "us-east-1", status: "Success: HTTP Status Code 200, OK", time: "2026-10-20T20:59:00Z" }]));
    expect(obs).toEqual([{ region: "us-east-1", ipAddress: "1.2.3.4", status: "Success: HTTP Status Code 200, OK", checkedTime: "2026-10-20T20:59:00Z" }]);
  });

  test("a health check is healthy only when more than 18% of checkers say so", () => {
    const mk = (ok: number, total: number) =>
      Array.from({ length: total }, (_, i) => ({ status: i < ok ? "Success: HTTP 200" : "Failure: timed out", checkedTime: `2026-10-20T20:5${i}:00Z` }));
    expect(healthCheckEntry(mk(2, 10), AT).state).toBe("healthy");
    expect(healthCheckEntry(mk(1, 10), AT).state).toBe("unhealthy");
    const e = healthCheckEntry(mk(2, 10), AT);
    expect(e.detail).toBe("2/10 checkers healthy; last: Failure: timed out");
    expect(e.checkedAt).toBe("2026-10-20T20:59:00Z");
    expect(healthCheckEntry([], AT).state).toBe("unknown");
  });

  test("an ECS service is running against desired", () => {
    expect(ecsServiceEntry({ status: "ACTIVE", desiredCount: 2, runningCount: 2 }, AT)).toMatchObject({ state: "healthy", detail: "2/2 running" });
    expect(ecsServiceEntry({ status: "ACTIVE", desiredCount: 3, runningCount: 1, pendingCount: 2 }, AT)).toMatchObject({ state: "unhealthy", detail: "1/3 running, 2 pending" });
    expect(ecsServiceEntry({ status: "ACTIVE", desiredCount: 0, runningCount: 0 }, AT).state).toBe("unknown");
    expect(ecsServiceEntry({ status: "DRAINING", desiredCount: 1, runningCount: 1 }, AT).state).toBe("unhealthy");
  });

  test("the cluster comes from the service ARN", () => {
    expect(clusterOfServiceArn("arn:aws:ecs:us-east-1:000000000000:service/app/web")).toBe("app");
    expect(clusterOfServiceArn("arn:aws:ecs:us-east-1:000000000000:service/web")).toBe("default");
  });

  test("reads both kinds through the endpoint override, keyed by logical id", async () => {
    const cfn: AwsReadHttp = async (url) => {
      expect(url).toBe("http://localhost:4566/");
      return {
        status: 200,
        text: stackXml([
          { logical: "web", type: "AWS::ECS::Service", physical: "arn:aws:ecs:us-east-1:000000000000:service/app/web" },
          { logical: "webCheck", type: "AWS::Route53::HealthCheck", physical: "abc-123" },
        ]),
      };
    };
    const calls: string[] = [];
    const http: AwsHealthHttp = async (method, url, init) => {
      calls.push(`${method} ${url}`);
      if (url.includes("/healthcheck/")) {
        return { status: 200, text: statusXml([{ region: "us-east-1", status: "Success: HTTP 200", time: "2026-10-20T20:58:00Z" }]) };
      }
      expect(JSON.parse(init.body!)).toEqual({ cluster: "app", services: ["arn:aws:ecs:us-east-1:000000000000:service/app/web"] });
      return {
        status: 200,
        text: JSON.stringify({ services: [{ serviceArn: "arn:aws:ecs:us-east-1:000000000000:service/app/web", status: "ACTIVE", desiredCount: 2, runningCount: 2 }], failures: [] }),
      };
    };
    const r = await observeHealthAws({
      environment: "dev",
      buildOutput: "",
      entities: new Map([
        ["web", { entityType: "AWS::ECS::Service", props: {} }],
        ["webCheck", { entityType: "AWS::Route53::HealthCheck", props: {} }],
        ["later", { entityType: "AWS::ECS::Service", props: {} }],
      ]),
      http,
      client: { http: cfn, env: ENV },
      now,
    });
    expect(r.entities.web).toMatchObject({ state: "healthy", observedAt: AT });
    expect(r.entities.webCheck).toMatchObject({ state: "healthy", checkedAt: "2026-10-20T20:58:00Z" });
    expect(r.absent).toEqual(["later"]);
    expect(calls).toContain("GET http://localhost:4566/2013-04-01/healthcheck/abc-123/status");
  });

  test("a missing stack is absent; a failed stack read is a hole for every entity", async () => {
    const entities = new Map([["web", { entityType: "AWS::ECS::Service", props: {} }]]);
    const missing: AwsReadHttp = async () => ({
      status: 400,
      text: "<ErrorResponse><Error><Code>ValidationError</Code><Message>Stack with id dev does not exist</Message></Error></ErrorResponse>",
    });
    const gone = await observeHealthAws({ environment: "dev", buildOutput: "", entities, client: { http: missing, env: ENV } });
    expect(gone.absent).toEqual(["web"]);

    const broken: AwsReadHttp = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const hole = await observeHealthAws({ environment: "dev", buildOutput: "", entities, client: { http: broken, env: ENV } });
    expect(hole.entities).toEqual({});
    expect(hole.unobserved.web?.reason).toBe("read-failed");
  });

  test("a failed service read is a hole, never unhealthy", async () => {
    const cfn: AwsReadHttp = async () => ({ status: 200, text: stackXml([{ logical: "web", type: "AWS::ECS::Service", physical: "arn:aws:ecs:us-east-1:0:service/app/web" }]) });
    const http: AwsHealthHttp = async () => ({ status: 400, text: JSON.stringify({ __type: "ClusterNotFoundException", message: "Cluster not found." }) });
    const r = await observeHealthAws({
      environment: "dev",
      buildOutput: "",
      entities: new Map([["web", { entityType: "AWS::ECS::Service", props: {} }]]),
      http,
      client: { http: cfn, env: ENV },
    });
    expect(r.unobserved.web).toMatchObject({ reason: "read-failed", detail: "ClusterNotFoundException: Cluster not found." });
  });

  test("the plugin names the types it reads", () => {
    expect(awsPlugin.healthTypes).toEqual(["AWS::Route53::HealthCheck", "AWS::ECS::Service"]);
    expect(typeof awsPlugin.observeHealth).toBe("function");
  });
});
