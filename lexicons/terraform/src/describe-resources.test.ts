/**
 * terraform describeResources tests (#2087).
 *
 * The declared side is real: `renderTerraformRoots` parses
 * `src/__fixtures__/with-module/` exactly as `buildRoots()` does, so the keys
 * this reader matches against are the keys a build produces, not keys a test
 * wrote down. The live side is `src/__fixtures__/show-state.json`, recorded
 * from `terraform show -json` after applying that same root with terraform
 * 1.15.8 against a local backend (`null_resource.third` was added to the HCL
 * afterwards, which is why it is declared and not in state).
 *
 * Nothing here runs terraform: the `init`/`show` activities are injected.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeObservationConformance } from "@intentius/chant-test-utils";
import { normalizeObservation } from "@intentius/chant/observation";
import type { Declarable } from "@intentius/chant/declarable";
import {
  describeResources,
  classifyStateOwnership,
  indexStateResources,
  TERRAFORM_STATE_OWNERSHIP_KEYS,
  type TerraformReadDeps,
} from "./describe-resources";
import { renderTerraformRoots } from "./hcl/roots";
import { terraformPlugin } from "./plugin";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const STATE: unknown = JSON.parse(readFileSync(join(fixtures, "show-state.json"), "utf-8"));

const ROOT_DIR = join(fixtures, "with-module");

/** `buildRoots()`'s own render of the fixture root, keyed `<root>/<address>`. */
async function declaredEntities(): Promise<Map<string, { entityType: string; props: Record<string, unknown> }>> {
  const { entities } = await renderTerraformRoots({
    projectRoot: fixtures,
    roots: { app: { dir: "./with-module" } },
  });
  const out = new Map<string, { entityType: string; props: Record<string, unknown> }>();
  for (const [key, entity] of entities) {
    out.set(key, {
      entityType: entity.entityType,
      props: (entity as Declarable & { props: Record<string, unknown> }).props,
    });
  }
  return out;
}

/** Injected activities that answer from the recorded state, with no child process. */
function deps(overrides?: Partial<TerraformReadDeps>): TerraformReadDeps {
  return {
    init: (async () => ({ dir: ROOT_DIR })) as TerraformReadDeps["init"],
    show: (async () => ({
      source: "state" as const,
      json: STATE,
      text: "",
      dir: ROOT_DIR,
      adds: 0,
      changes: 0,
      destroys: 0,
    })) as TerraformReadDeps["show"],
    ...overrides,
  };
}

const failing = (message: string): TerraformReadDeps["show"] =>
  (async () => {
    throw new Error(message);
  }) as TerraformReadDeps["show"];

async function options(overrides?: { owned?: boolean; only?: string[] }) {
  const entities = await declaredEntities();
  const entityNames = overrides?.only ?? [...entities.keys()].sort();
  return {
    environment: "prod",
    buildOutput: "",
    entityNames,
    entities,
    ...(overrides?.owned ? { owned: true } : {}),
  };
}

describe("indexStateResources (#2087)", () => {
  it("indexes root-module and child-module rows by fully qualified address", () => {
    const index = indexStateResources(STATE);
    expect([...index.rows.keys()].sort()).toEqual([
      "module.cdn.null_resource.edge",
      "null_resource.first",
      "null_resource.second",
    ]);
    expect(index.modules).toContain("module.cdn");
  });

  it("does not double-prefix an address terraform already qualified", () => {
    // Real `terraform show -json` writes `module.cdn.null_resource.edge`
    // inside `child_modules`, already qualified — see the fixture.
    const index = indexStateResources(STATE);
    expect(index.rows.has("module.cdn.module.cdn.null_resource.edge")).toBe(false);
  });

  it("prefixes a bare address, for an output shape that does not qualify it", () => {
    const index = indexStateResources({
      values: {
        root_module: {
          child_modules: [{ address: "module.cdn", resources: [{ address: "null_resource.edge" }] }],
        },
      },
    });
    expect([...index.rows.keys()]).toEqual(["module.cdn.null_resource.edge"]);
  });

  it("reads nothing from a document with no values at all", () => {
    expect(indexStateResources({}).rows.size).toBe(0);
    expect(indexStateResources(null).rows.size).toBe(0);
  });
});

describe("classifyStateOwnership (#2087)", () => {
  const index = indexStateResources(STATE);

  it("an address in state is owned — state membership IS the channel", () => {
    expect(classifyStateOwnership("null_resource.first", index)).toBe("owned");
    expect(classifyStateOwnership("module.cdn.null_resource.edge", index)).toBe("owned");
  });

  it("an address outside state is unknown, never foreign", () => {
    // `foreign` would claim chant looked at a marker and found someone else's.
    // There is no marker: the state simply has no row.
    expect(classifyStateOwnership("null_resource.third", index)).toBe("unknown");
    expect(classifyStateOwnership("module.cdn", index)).toBe("unknown");
  });

  it("the declared channel keys name the state, not a tag", () => {
    expect(TERRAFORM_STATE_OWNERSHIP_KEYS.managedBy).toBe("terraform.state");
    expect(terraformPlugin.ownershipChannel).toEqual({
      keys: TERRAFORM_STATE_OWNERSHIP_KEYS,
      reads: ["describeResources"],
    });
  });
});

describe("terraform describeResources (#2087)", () => {
  it("maps state addresses onto the keys buildRoots() produces", async () => {
    const { resources } = normalizeObservation(await describeResources(await options(), deps()));
    expect(resources["app/null_resource.first"]).toMatchObject({
      type: "Terraform::Resource",
      physicalId: "1710777879587847269",
      status: "managed",
      ownership: "owned",
    });
    expect(resources["app/null_resource.second"].ownership).toBe("owned");
    expect(resources["app/null_resource.first"].attributes).toEqual({
      address: "null_resource.first",
      root: "app",
      resourceType: "null_resource",
      mode: "managed",
      provider: "registry.terraform.io/hashicorp/null",
    });
  });

  it("never surfaces a state row's attribute values", async () => {
    // `values` is the full attribute set, provider secrets included; only the
    // `id` is read out of it, as the physical id.
    const result = await describeResources(await options(), deps());
    expect(JSON.stringify(result)).not.toContain("triggers");
    for (const meta of Object.values(normalizeObservation(result).resources)) {
      expect(meta.attributes).not.toHaveProperty("values");
      expect(meta.attributes).not.toHaveProperty("triggers");
    }
  });

  it("reports a declared resource with no state row as absent, not not-observed", async () => {
    const { resources, unobserved, queried } = normalizeObservation(
      await describeResources(await options(), deps()),
    );
    expect(resources).not.toHaveProperty("app/null_resource.third");
    expect(unobserved).not.toHaveProperty("app/null_resource.third");
    // Absence is spelled "in neither map", so `queried` is the only place it
    // can say where it looked (#1620).
    expect(queried["app/null_resource.third"]).toContain("null_resource.third");
  });

  it("reports a declared module block as present but unknown — the state has no row for it", async () => {
    const { resources } = normalizeObservation(await describeResources(await options(), deps()));
    expect(resources["app/module.cdn"]).toMatchObject({
      type: "Terraform::Module",
      physicalId: "module.cdn",
      status: "module",
      ownership: "unknown",
    });
  });

  it("reports blocks that state does not record at all as unsupported-kind", async () => {
    const { unobserved } = normalizeObservation(await describeResources(await options(), deps()));
    for (const name of ["app/terraform", "app/provider.null", "app/var.region"]) {
      expect(unobserved[name].reason).toBe("unsupported-kind");
      expect(unobserved[name].detail).toContain("terraform state");
    }
  });

  it("surfaces no ownership marker — there is no marker channel to read one off", async () => {
    const { resources } = normalizeObservation(await describeResources(await options(), deps()));
    for (const meta of Object.values(resources)) expect(meta.marker).toBeUndefined();
  });

  it("names the root when the read is issued", async () => {
    const { queried } = normalizeObservation(await describeResources(await options(), deps()));
    expect(queried["app/null_resource.first"]).toBe(
      'terraform show -json (root "app", address "null_resource.first")',
    );
  });
});

describe("terraform describeResources failed reads (#2087)", () => {
  it("a failed show reports every declared entity of that root read-failed, naming the root", async () => {
    const opts = await options();
    const { resources, unobserved } = normalizeObservation(
      await describeResources(opts, deps({ show: failing("Error acquiring the state lock") })),
    );
    expect(Object.keys(resources)).toEqual([]);
    expect(Object.keys(unobserved).sort()).toEqual([...opts.entityNames].sort());
    for (const entry of Object.values(unobserved)) {
      expect(entry.reason).toBe("read-failed");
      expect(entry.detail).toContain("terraform.roots.app");
      expect(entry.detail).toContain("Error acquiring the state lock");
    }
  });

  it("a failed init is read-failed too, and no entity is ever absent", async () => {
    const opts = await options();
    const failingInit = (async () => {
      throw new Error("Backend initialization required");
    }) as TerraformReadDeps["init"];
    const { resources, unobserved } = normalizeObservation(
      await describeResources(opts, deps({ init: failingInit })),
    );
    expect(Object.keys(resources)).toEqual([]);
    for (const name of opts.entityNames) {
      expect(unobserved[name].reason).toBe("read-failed");
      expect(unobserved[name].detail).toContain("Backend initialization required");
    }
  });

  it("one broken root does not un-observe a root that answered", async () => {
    const entities = await declaredEntities();
    entities.set("other/null_resource.away", {
      entityType: "Terraform::Resource",
      props: { address: "null_resource.away", root: "other", body: {}, file: "main.tf" },
    });
    const brokenRoot: TerraformReadDeps = {
      init: (async (args: { root: string }) => {
        if (args.root === "other") throw new Error("no backend configured");
        return { dir: ROOT_DIR };
      }) as TerraformReadDeps["init"],
      show: deps().show,
    };
    const { resources, unobserved } = normalizeObservation(
      await describeResources(
        {
          environment: "prod",
          buildOutput: "",
          entityNames: ["app/null_resource.first", "other/null_resource.away"],
          entities,
        },
        brokenRoot,
      ),
    );
    expect(resources["app/null_resource.first"].ownership).toBe("owned");
    expect(unobserved["other/null_resource.away"].reason).toBe("read-failed");
    expect(unobserved["other/null_resource.away"].detail).toContain("terraform.roots.other");
  });
});

describe("terraform describeResources --owned (#2087)", () => {
  it("withholds a non-owned present entity as filtered, never as absent", async () => {
    const { resources, unobserved } = normalizeObservation(
      await describeResources(await options({ owned: true }), deps()),
    );
    expect(resources).not.toHaveProperty("app/module.cdn");
    expect(unobserved["app/module.cdn"].reason).toBe("filtered");
    expect(Object.keys(resources).sort()).toEqual([
      "app/null_resource.first",
      "app/null_resource.second",
    ]);
  });
});

describeObservationConformance({
  lexicon: "terraform",
  ownershipChannel: terraformPlugin.ownershipChannel,
  scenarios: [
    {
      name: "resources in state",
      declared: ["app/null_resource.first", "app/null_resource.second"],
      expectPresent: ["app/null_resource.first", "app/null_resource.second"],
      expectNoMarker: ["app/null_resource.first"],
      run: async () =>
        describeResources(
          await options({ only: ["app/null_resource.first", "app/null_resource.second"] }),
          deps(),
        ),
    },
    {
      name: "declared but not in state",
      declared: ["app/null_resource.third"],
      expectAbsent: ["app/null_resource.third"],
      run: async () => describeResources(await options({ only: ["app/null_resource.third"] }), deps()),
    },
    {
      name: "the state lock is held",
      declared: ["app/null_resource.first", "app/module.cdn"],
      expectUnobserved: ["app/null_resource.first", "app/module.cdn"],
      run: async () =>
        describeResources(
          await options({ only: ["app/null_resource.first", "app/module.cdn"] }),
          deps({ show: failing("Error acquiring the state lock") }),
        ),
    },
    {
      name: "a block terraform state has no row for",
      declared: ["app/provider.null"],
      expectUnobserved: ["app/provider.null"],
      run: async () => describeResources(await options({ only: ["app/provider.null"] }), deps()),
    },
    {
      name: "owned read, with the module block filtered out",
      declared: ["app/null_resource.first", "app/module.cdn"],
      owned: true,
      expectPresent: ["app/null_resource.first"],
      expectUnobserved: ["app/module.cdn"],
      run: async () =>
        describeResources(
          await options({ only: ["app/null_resource.first", "app/module.cdn"], owned: true }),
          deps(),
        ),
    },
  ],
});
