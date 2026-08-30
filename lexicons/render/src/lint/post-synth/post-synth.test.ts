import { describe, test, expect } from "vitest";
import type { Declarable } from "@intentius/chant";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { ren010 } from "./ren010-native-runtime-requires-commands";
import { ren011 } from "./ren011-service-requires-source";
import { ren012 } from "./ren012-free-plan-cannot-scale";
import { postSynthChecks } from "./index";
import {
  WebService,
  WebServiceDetails,
  NativeEnvironmentDetails,
  DockerDetails,
  StaticSite,
  StaticSiteDetails,
  Image,
  ServiceDisk,
  Postgres,
} from "../../generated/index";

function ctx(...entries: Array<[string, unknown]>): PostSynthContext {
  const entities = new Map(entries as Array<[string, Declarable]>);
  return {
    outputs: new Map(),
    entities,
    buildResult: { outputs: new Map(), entities, warnings: [], errors: [], sourceFileCount: 1 },
  };
}

const REPO = "https://github.com/render-examples/express-hello-world";

describe("render post-synth checks", () => {
  test("the barrel exports the three checks", () => {
    expect(postSynthChecks.map((c) => c.id)).toEqual(["REN010", "REN011", "REN012"]);
  });

  describe("REN010: native runtime requires build/start commands", () => {
    test("flags a node service with no envSpecificDetails", () => {
      const diags = ren010.check(ctx(["web", new WebService({ name: "web", repo: REPO, serviceDetails: new WebServiceDetails({ runtime: "node" }) })]));
      expect(diags).toHaveLength(1);
      expect(diags[0].checkId).toBe("REN010");
      expect(diags[0].severity).toBe("error");
      expect(diags[0].message).toContain("buildCommand or startCommand");
    });

    test("passes a node service with both commands (instance and inline forms)", () => {
      expect(
        ren010.check(
          ctx([
            "web",
            new WebService({
              name: "web",
              repo: REPO,
              serviceDetails: new WebServiceDetails({
                runtime: "node",
                envSpecificDetails: new NativeEnvironmentDetails({ buildCommand: "npm ci", startCommand: "npm start" }),
              }),
            }),
          ]),
        ),
      ).toHaveLength(0);
      expect(
        ren010.check(
          ctx([
            "web",
            new WebService({
              name: "web",
              repo: REPO,
              serviceDetails: { runtime: "python", envSpecificDetails: { buildCommand: "pip install -r requirements.txt", startCommand: "gunicorn app:app" } } as unknown as InstanceType<typeof WebServiceDetails>,
            }),
          ]),
        ),
      ).toHaveLength(0);
    });

    test("ignores docker/image runtimes, static sites, and non-services", () => {
      expect(
        ren010.check(
          ctx(
            ["d", new WebService({ name: "d", repo: REPO, serviceDetails: new WebServiceDetails({ runtime: "docker", envSpecificDetails: new DockerDetails({}) }) })],
            ["i", new WebService({ name: "i", image: new Image({ imagePath: "nginx" }), serviceDetails: new WebServiceDetails({ runtime: "image" }) })],
            ["s", new StaticSite({ name: "s", repo: REPO, serviceDetails: new StaticSiteDetails({}) })],
            ["db", new Postgres({ name: "db", plan: "free", version: "16" })],
          ),
        ),
      ).toHaveLength(0);
    });
  });

  describe("REN011: service requires a source", () => {
    test("flags a service with neither repo nor image", () => {
      const diags = ren011.check(ctx(["web", new WebService({ name: "web", serviceDetails: new WebServiceDetails({ runtime: "docker" }) })]));
      expect(diags).toHaveLength(1);
      expect(diags[0].checkId).toBe("REN011");
      expect(diags[0].message).toContain("neither a repo nor an image");
    });

    test("flags runtime image without an image", () => {
      const diags = ren011.check(ctx(["web", new WebService({ name: "web", repo: REPO, serviceDetails: new WebServiceDetails({ runtime: "image" }) })]));
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain('runtime "image"');
    });

    test("passes a repo-backed and an image-backed service", () => {
      expect(
        ren011.check(
          ctx(
            ["r", new WebService({ name: "r", repo: REPO, serviceDetails: new WebServiceDetails({ runtime: "docker" }) })],
            ["i", new WebService({ name: "i", image: new Image({ imagePath: "docker.io/library/nginx:latest" }), serviceDetails: new WebServiceDetails({ runtime: "image" }) })],
          ),
        ),
      ).toHaveLength(0);
    });
  });

  describe("REN012: free plan cannot scale", () => {
    test("flags numInstances, autoscaling, and disk on free", () => {
      const diags = ren012.check(
        ctx([
          "web",
          new WebService({
            name: "web",
            repo: REPO,
            serviceDetails: new WebServiceDetails({
              runtime: "docker",
              plan: "free",
              numInstances: 3,
              autoscaling: { enabled: true, min: 1, max: 3, criteria: { cpu: { enabled: true, percentage: 70 }, memory: { enabled: false, percentage: 70 } } },
              disk: new ServiceDisk({ name: "data", mountPath: "/data" }),
            }),
          }),
        ]),
      );
      expect(diags).toHaveLength(1);
      expect(diags[0].checkId).toBe("REN012");
      expect(diags[0].message).toContain("numInstances: 3");
      expect(diags[0].message).toContain("autoscaling");
      expect(diags[0].message).toContain("a disk");
    });

    test("passes a free single-instance service and a scaled paid one", () => {
      expect(
        ren012.check(
          ctx(
            ["f", new WebService({ name: "f", repo: REPO, serviceDetails: new WebServiceDetails({ runtime: "docker", plan: "free" }) })],
            ["p", new WebService({ name: "p", repo: REPO, serviceDetails: new WebServiceDetails({ runtime: "docker", plan: "standard", numInstances: 3 }) })],
          ),
        ),
      ).toHaveLength(0);
    });
  });
});
