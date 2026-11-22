/**
 * Where a cloudformation or cdk workspace member's state lives (#5456), as the
 * entries `chant workspace state` reads from the member graph's
 * `meta.stateLocations`. The state of a CloudFormation stack is the stack, so
 * the location is its name and region. Pure: it reads the member's report and
 * makes no call.
 */
import type { AwsMemberReport } from "./workspace-member";

export interface AwsStateLocation {
  environment: null;
  unit?: string;
  substrate: "aws";
  backend: { kind: "cloudformation-stack"; location: Record<string, string | null> };
  lock: { mechanism: "cloudformation-stack-update" } | null;
  reach: { status: "reachable" } | { status: "unreachable"; reason: string } | { status: "unchecked"; reason: string };
}

const NO_STACK =
  "the member's templates name no deployed stack; name the stacks in cloudformation-stacks.json to read them";

/**
 * One entry per stack the member names, `reachable` when the stack was read and
 * `unreachable` with the reason when it was not. A member with no named stack
 * (a template file, or a cdk assembly) has one entry with no stack name, since
 * its files do not say which stack holds the state.
 */
export function awsStateLocations(report: AwsMemberReport): AwsStateLocation[] {
  if (report.stacks && report.stacks.length > 0) {
    return report.stacks.map((s) => ({
      environment: null,
      unit: s.name,
      substrate: "aws" as const,
      backend: { kind: "cloudformation-stack" as const, location: { stack: s.name, region: s.region ?? null } },
      lock: { mechanism: "cloudformation-stack-update" as const },
      reach: s.read ? { status: "reachable" as const } : { status: "unreachable" as const, reason: s.reason ?? "the stack was not read" },
    }));
  }
  return [
    {
      environment: null,
      substrate: "aws",
      backend: { kind: "cloudformation-stack", location: { stack: null, region: null } },
      lock: null,
      reach: { status: "unchecked", reason: NO_STACK },
    },
  ];
}
