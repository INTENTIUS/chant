/**
 * The `state` document (#5456): what each member's lexicon publishes on its
 * graph meta, projected and masked; its schema; and its text form.
 */
import { describe, expect, test } from "vitest";
import { contract, validSchema } from "./__fixtures__/contract-repo";
import type { ComposedMember, WorkspaceGraph } from "./compose-graph";
import { formatState } from "./state-cli";
import {
  readStateLocations,
  stateDocument,
  STATE_CONTRACT_VERSION,
  STATE_LOCATIONS_META_KEY,
  STATE_OUTPUT_SCHEMA_ID,
  withoutUrlCredentials,
} from "./state-locations";
import schema from "./state.schema.json";

const { expectValid } = contract(schema);

const member = (name: string, kind: string, meta?: Record<string, unknown>, status: ComposedMember["status"] = "composed"): ComposedMember => ({
  name,
  dir: name,
  kind,
  status,
  reason: status === "composed" ? null : { code: "kind-not-run", message: "the kind is not run" },
  chant: "0.124.0",
  irVersion: 1,
  live: false,
  ...(meta ? { meta } : {}),
});

const graph = (members: ComposedMember[]): WorkspaceGraph =>
  ({ version: 1, workspace: { name: "estate", root: ".", repo: null }, members, nodes: [], edges: [], groups: { byMember: {} } }) as unknown as WorkspaceGraph;

const head = { $schema: STATE_OUTPUT_SCHEMA_ID, contract: STATE_CONTRACT_VERSION, chant: "0.124.0", at: null };

const s3 = (environment: string | null, extra: Record<string, unknown> = {}) => ({
  environment,
  unit: "network",
  substrate: "terraform",
  backend: { kind: "s3", location: { bucket: "acme-tfstate", key: "network.tfstate", region: "eu-west-1", ...extra } },
  lock: { mechanism: "dynamodb", location: { table: "acme-tflock" } },
  reach: { status: "unchecked", reason: "read from configuration" },
});

describe("state.schema.json", () => {
  test("is a valid draft 2020-12 document at the contract version", () => {
    expect(validSchema(schema)).toBe(true);
    expect(schema.$id).toBe(STATE_OUTPUT_SCHEMA_ID);
    for (const branch of ["result", "failure"] as const) {
      const props = (schema.$defs as unknown as Record<string, { properties: Record<string, unknown> }>)[branch].properties;
      expect(props.contract).toEqual({ const: 1 });
      expect(props.$schema).toEqual({ const: schema.$id });
    }
  });
});

describe("readStateLocations", () => {
  test("a member whose lexicon publishes nothing is not published, and no location is invented", () => {
    expect(readStateLocations({ k8sMember: {} })).toEqual({ published: false, states: [] });
    expect(readStateLocations(undefined)).toEqual({ published: false, states: [] });
  });

  test("an entry without a substrate, a backend kind or a location is dropped", () => {
    const { published, states } = readStateLocations({
      [STATE_LOCATIONS_META_KEY]: [s3(null), { environment: null, backend: { kind: "s3", location: {} } }, { substrate: "x", backend: { location: {} } }, { substrate: "x", backend: { kind: "s3" } }],
    });
    expect(published).toBe(true);
    expect(states).toHaveLength(1);
  });

  test("a value that carries a secret is masked, and a URL loses its user and password", () => {
    const { states } = readStateLocations({
      [STATE_LOCATIONS_META_KEY]: [
        {
          environment: null,
          substrate: "terraform",
          backend: { kind: "http", location: { address: "https://deploy:hunter2@gitlab.example.test/api/v4/projects/9/terraform/state/prod", access_key: "AKIA123", sas_token: "?sv=2024", password: "", bucket: "b" } },
          lock: null,
          reach: { status: "unchecked" },
        },
      ],
    });
    expect(states[0]!.backend.location).toEqual({
      access_key: "***",
      address: "https://gitlab.example.test/api/v4/projects/9/terraform/state/prod",
      bucket: "b",
      password: null,
      sas_token: "***",
    });
    expect(JSON.stringify(states)).not.toMatch(/hunter2|AKIA123|sv=2024/);
  });

  test("entries sort by environment, unit and backend kind", () => {
    const { states } = readStateLocations({ [STATE_LOCATIONS_META_KEY]: [s3("prod"), s3(null), s3("dev")] });
    expect(states.map((s) => s.environment)).toEqual([null, "dev", "prod"]);
  });

  test("an unknown reach is unchecked", () => {
    const { states } = readStateLocations({ [STATE_LOCATIONS_META_KEY]: [{ ...s3(null), reach: { status: "maybe" } }] });
    expect(states[0]!.reach).toEqual({ status: "unchecked" });
  });
});

describe("withoutUrlCredentials", () => {
  test("removes the user and password and leaves anything else", () => {
    expect(withoutUrlCredentials("https://u:p@host/x")).toBe("https://host/x");
    expect(withoutUrlCredentials("https://host/x@y")).toBe("https://host/x@y");
    expect(withoutUrlCredentials("acme-tfstate")).toBe("acme-tfstate");
  });
});

describe("stateDocument", () => {
  const members = [
    member("network", "terraform", { [STATE_LOCATIONS_META_KEY]: [s3("prod"), s3("dev"), s3(null)] }),
    member("web", "chant", { awsMember: {} }),
    member("docs", "other", undefined, "skipped"),
  ];

  test("lists every member, sorted, with what each publishes and a summary", () => {
    const doc = stateDocument(graph(members), head, null);
    expectValid(doc);
    expect(doc.members.map((m) => [m.member, m.status, m.published, m.states.length])).toEqual([
      ["docs", "skipped", false, 0],
      ["network", "read", true, 3],
      ["web", "read", false, 0],
    ]);
    expect(doc.members[0]!.reason?.code).toBe("kind-not-run");
    expect(doc.summary).toEqual({ members: 3, published: 1, locations: 3, unreachable: 0 });
    expect(doc.environment).toBeNull();
  });

  test("--env keeps that environment's entries and the ones that name none", () => {
    const doc = stateDocument(graph(members), head, "prod");
    expectValid(doc);
    expect(doc.members.find((m) => m.member === "network")!.states.map((s) => s.environment)).toEqual([null, "prod"]);
    expect(doc.environment).toBe("prod");
  });

  test("counts an unreachable state", () => {
    const doc = stateDocument(graph([member("n", "cloudformation", { [STATE_LOCATIONS_META_KEY]: [{ ...s3(null), reach: { status: "unreachable", reason: "no stack named x in eu-west-1" } }] })]), head, null);
    expectValid(doc);
    expect(doc.summary.unreachable).toBe(1);
  });
});

describe("formatState", () => {
  test("one row per location, a line for a member with none, and the summary", () => {
    const text = formatState(stateDocument(graph([member("network", "terraform", { [STATE_LOCATIONS_META_KEY]: [s3("prod")] }), member("web", "chant")]), head, null));
    expect(text).toContain("network  prod");
    expect(text).toContain("s3");
    expect(text).toContain("bucket=acme-tfstate key=network.tfstate region=eu-west-1");
    expect(text).toContain("dynamodb");
    expect(text).toContain("web: its lexicon publishes no state location");
    expect(text).toMatch(/2 members, 1 with state locations, 1 location, 0 unreachable/);
  });
});
