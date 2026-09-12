import { phase, stackOutput, type Component } from "@intentius/chant/components";

/**
 * The twelve apps: six on `cluster-a`, six on `cluster-b`.
 *
 * They live in one file because chant discovers every exported `Component` from
 * a `*.component.ts`, and twelve near-identical files would hide the one thing
 * worth seeing here, which is that app-01 through app-06 name `cluster-a` and
 * app-07 through app-12 name `cluster-b`. Their source directories are still
 * one per stack, since a stack is a build root.
 *
 * Each component names its cluster twice: once in `dependsOn`, which orders the
 * run, and once in `stackOutput(...)`, which fills the `TableName` parameter
 * that `src/app-NN/resources.ts` builds its log group name out of.
 */

export const app01: Component = {
  name: "app-01",
  archetype: "service",
  dependsOn: ["cluster-a"],
  deploy: [
    phase("Apply", [
      {
        kind: "cfn-deploy",
        stack: "app-01",
        template: "dist/app-01.template.json",
        inputs: { app01TableName: stackOutput("cluster-a", "TableName") },
      },
    ]),
  ],
};

export const app02: Component = {
  name: "app-02",
  archetype: "service",
  dependsOn: ["cluster-a"],
  deploy: [
    phase("Apply", [
      {
        kind: "cfn-deploy",
        stack: "app-02",
        template: "dist/app-02.template.json",
        inputs: { app02TableName: stackOutput("cluster-a", "TableName") },
      },
    ]),
  ],
};

export const app03: Component = {
  name: "app-03",
  archetype: "service",
  dependsOn: ["cluster-a"],
  deploy: [
    phase("Apply", [
      {
        kind: "cfn-deploy",
        stack: "app-03",
        template: "dist/app-03.template.json",
        inputs: { app03TableName: stackOutput("cluster-a", "TableName") },
      },
    ]),
  ],
};

export const app04: Component = {
  name: "app-04",
  archetype: "service",
  dependsOn: ["cluster-a"],
  deploy: [
    phase("Apply", [
      {
        kind: "cfn-deploy",
        stack: "app-04",
        template: "dist/app-04.template.json",
        inputs: { app04TableName: stackOutput("cluster-a", "TableName") },
      },
    ]),
  ],
};

export const app05: Component = {
  name: "app-05",
  archetype: "service",
  dependsOn: ["cluster-a"],
  deploy: [
    phase("Apply", [
      {
        kind: "cfn-deploy",
        stack: "app-05",
        template: "dist/app-05.template.json",
        inputs: { app05TableName: stackOutput("cluster-a", "TableName") },
      },
    ]),
  ],
};

export const app06: Component = {
  name: "app-06",
  archetype: "service",
  dependsOn: ["cluster-a"],
  deploy: [
    phase("Apply", [
      {
        kind: "cfn-deploy",
        stack: "app-06",
        template: "dist/app-06.template.json",
        inputs: { app06TableName: stackOutput("cluster-a", "TableName") },
      },
    ]),
  ],
};

export const app07: Component = {
  name: "app-07",
  archetype: "service",
  dependsOn: ["cluster-b"],
  deploy: [
    phase("Apply", [
      {
        kind: "cfn-deploy",
        stack: "app-07",
        template: "dist/app-07.template.json",
        inputs: { app07TableName: stackOutput("cluster-b", "TableName") },
      },
    ]),
  ],
};

export const app08: Component = {
  name: "app-08",
  archetype: "service",
  dependsOn: ["cluster-b"],
  deploy: [
    phase("Apply", [
      {
        kind: "cfn-deploy",
        stack: "app-08",
        template: "dist/app-08.template.json",
        inputs: { app08TableName: stackOutput("cluster-b", "TableName") },
      },
    ]),
  ],
};

export const app09: Component = {
  name: "app-09",
  archetype: "service",
  dependsOn: ["cluster-b"],
  deploy: [
    phase("Apply", [
      {
        kind: "cfn-deploy",
        stack: "app-09",
        template: "dist/app-09.template.json",
        inputs: { app09TableName: stackOutput("cluster-b", "TableName") },
      },
    ]),
  ],
};

export const app10: Component = {
  name: "app-10",
  archetype: "service",
  dependsOn: ["cluster-b"],
  deploy: [
    phase("Apply", [
      {
        kind: "cfn-deploy",
        stack: "app-10",
        template: "dist/app-10.template.json",
        inputs: { app10TableName: stackOutput("cluster-b", "TableName") },
      },
    ]),
  ],
};

export const app11: Component = {
  name: "app-11",
  archetype: "service",
  dependsOn: ["cluster-b"],
  deploy: [
    phase("Apply", [
      {
        kind: "cfn-deploy",
        stack: "app-11",
        template: "dist/app-11.template.json",
        inputs: { app11TableName: stackOutput("cluster-b", "TableName") },
      },
    ]),
  ],
};

export const app12: Component = {
  name: "app-12",
  archetype: "service",
  dependsOn: ["cluster-b"],
  deploy: [
    phase("Apply", [
      {
        kind: "cfn-deploy",
        stack: "app-12",
        template: "dist/app-12.template.json",
        inputs: { app12TableName: stackOutput("cluster-b", "TableName") },
      },
    ]),
  ],
};
