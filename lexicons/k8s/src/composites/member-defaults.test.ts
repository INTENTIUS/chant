import { describe, test, expect, expectTypeOf } from "vitest";
import { StatefulApp } from "./stateful-app";
import { WebApp } from "./web-app";
import type { MemberDefaults } from "./member-defaults";

describe("member defaults are typed against generated props", () => {
  test("a gRPC probe override is accepted and reaches the output", () => {
    const { statefulSet } = StatefulApp({
      name: "db",
      image: "postgres:16",
      defaults: {
        statefulSet: {
          spec: {
            revisionHistoryLimit: 3,
            template: {
              spec: {
                enableServiceLinks: false,
                containers: [
                  {
                    name: "sidecar",
                    image: "probe:1",
                    livenessProbe: { grpc: { port: 9000 }, periodSeconds: 10 },
                  },
                ],
              },
            },
          },
        },
      },
    });
    const spec = (statefulSet as unknown as { props: { spec: Record<string, unknown> } }).props.spec;
    expect(spec.revisionHistoryLimit).toBe(3);
  });

  test("wrong-typed overrides are rejected by the compiler", () => {
    StatefulApp({
      name: "db",
      image: "postgres:16",
      defaults: {
        // @ts-expect-error revisionHistoryLimit is a number
        statefulSet: { spec: { revisionHistoryLimit: "three" } },
      },
    });

    WebApp({
      name: "web",
      image: "nginx:1",
      defaults: {
        // @ts-expect-error grpc.port is a number
        deployment: { spec: { template: { spec: { containers: [{ name: "c", livenessProbe: { grpc: { port: "x" } } }] } } } },
      },
    });

    // @ts-expect-error not a StatefulSet field
    const bad: MemberDefaults<"StatefulSet"> = { replicas: 2 };
    expect(bad).toBeDefined();
  });

  test("MemberDefaults keeps nested objects optional", () => {
    expectTypeOf<{ spec: { replicas: number } }>().toMatchTypeOf<MemberDefaults<"StatefulSet">>();
    expectTypeOf<{ spec: { replicas: string } }>().not.toMatchTypeOf<MemberDefaults<"StatefulSet">>();
  });
});
