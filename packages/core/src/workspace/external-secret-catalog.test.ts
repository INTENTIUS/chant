/**
 * #5098: an ExternalSecret to its store and to the cloud secret the store
 * reads it from, over a composed workspace graph with the k8s catalog and
 * the terraform catalog together. Members `k8s` and `tf` stand for a manifest
 * directory and a terraform root.
 */
import { describe, expect, it } from "vitest";
import { k8sReferenceCatalog } from "../../../../lexicons/k8s/src/reference-catalog";
import { TERRAFORM_REFERENCE_CATALOG } from "../../../../lexicons/terraform/src/behaviour/reference-catalog";
import { placeCatalogPass, runCatalogPass } from "./catalog-edges";
import type { ComposedNode, WorkspaceGraph } from "./compose-graph";

const ES = "K8s::ExternalSecrets::ExternalSecret";
const CSS = "K8s::ExternalSecrets::ClusterSecretStore";
const SS = "K8s::ExternalSecrets::SecretStore";
const STORE_RULE = `k8s:${ES}:spec.secretStoreRef.name`;
const KEY_RULE = `k8s:${ES}:spec.data[].remoteRef.key`;
const FROM_RULE = `k8s:${ES}:spec.dataFrom[].extract.key`;

const k8s = (id: string, kind: string, attrs: Record<string, unknown>, member = "k8s"): ComposedNode => ({ id: `${member}/${id}`, kind, lexicon: "k8s", attrs, member });
const tf = (address: string, body: Record<string, unknown>, member = "tf"): ComposedNode => ({
  id: `${member}/r/${address}`,
  kind: "Terraform::Resource",
  lexicon: "terraform",
  member,
  attrs: { address, type: address.split(".")[0], name: address.split(".")[1], body, source: "main.tf" },
});

const gcpStore = (name = "gcp", projectID = "demo-proj") => k8s(`cs-${name}`, CSS, { metadata: { name }, spec: { provider: { gcpsm: { projectID } } } });
const externalSecret = (spec: Record<string, unknown>, namespace: string | null = "app") =>
  k8s("es-app-creds", ES, { metadata: { name: "app-creds", ...(namespace ? { namespace } : {}) }, spec });
const gcpSecret = (secretId: string, project: string | null = "demo-proj", address = "google_secret_manager_secret.token") =>
  tf(address, { secret_id: secretId, ...(project ? { project } : {}), replication: [{ auto: {} }] });

const pass = (nodes: ComposedNode[]) =>
  runCatalogPass(nodes, [
    { lexicon: "k8s", catalog: k8sReferenceCatalog },
    { lexicon: "terraform", catalog: TERRAFORM_REFERENCE_CATALOG },
  ]);

const uses = (store: string, key: string, kind = "ClusterSecretStore") => ({ secretStoreRef: { kind, name: store }, data: [{ secretKey: "token", remoteRef: { key } }] });
const refEdges = (out: ReturnType<typeof pass>) => out.edges.filter((e) => e.relation === "reference").map((e) => `${e.from} -> ${e.to} [${e.viaAttr}] ${e.rule}`);

describe("an ExternalSecret and its store (#5098)", () => {
  it("draws the edge to the store and the edge to the cloud secret", () => {
    const out = pass([gcpStore(), externalSecret(uses("gcp", "app-token")), gcpSecret("app-token")]);
    expect(refEdges(out)).toEqual([
      `k8s/es-app-creds -> k8s/cs-gcp [secretStoreRef] ${STORE_RULE}`,
      `k8s/es-app-creds -> tf/r/google_secret_manager_secret.token [remoteRef.key via gcp] ${KEY_RULE}`,
    ]);
    expect(out.edges.every((e) => e.origin === "derived" && e.grain === "property")).toBe(true);
    expect(out.dangling.filter((d) => d.rule?.includes("ExternalSecret"))).toEqual([]);
    expect(out.ambiguous).toEqual([]);
  });

  it("names both rules, with the store kinds and the secret kind they look for, once placed", () => {
    const graph = { version: 1, workspace: { name: "w", root: "." }, members: [], nodes: [], edges: [], groups: { byMember: {} }, exports: [], imports: [], links: [], collectors: [], records: [] } as unknown as WorkspaceGraph;
    placeCatalogPass(graph, pass([gcpStore(), externalSecret(uses("gcp", "app-token")), gcpSecret("app-token")]));
    expect(graph.catalog?.rules[STORE_RULE]).toMatchObject({ from: ES, path: "spec.secretStoreRef.name", targetKinds: [CSS, SS], label: "reads through" });
    expect(graph.catalog?.rules[KEY_RULE]).toMatchObject({ from: ES, path: "spec.data[].remoteRef.key", targetKinds: ["aws_secretsmanager_secret", "google_secret_manager_secret"], label: "reads secret" });
  });

  it("gives a SecretStore of that name in another namespace no edge", () => {
    const other = k8s("ss-gcp", SS, { metadata: { name: "gcp", namespace: "elsewhere" }, spec: { provider: { gcpsm: { projectID: "demo-proj" } } } });
    const out = pass([other, externalSecret(uses("gcp", "app-token", "SecretStore")), gcpSecret("app-token")]);
    expect(refEdges(out)).toEqual([]);
    expect(out.dangling.filter((d) => d.rule === STORE_RULE)).toEqual([
      expect.objectContaining({ from: "k8s/es-app-creds", value: "gcp", targetKind: SS }),
    ]);
    // A store that is not found leaves its keys unread: the store entry says what is missing.
    expect(out.dangling.filter((d) => d.rule === KEY_RULE)).toEqual([]);
  });

  it("reads a store with no kind as a SecretStore in the namespace", () => {
    const store = k8s("ss-gcp", SS, { metadata: { name: "gcp", namespace: "app" }, spec: { provider: { gcpsm: { projectID: "demo-proj" } } } });
    const out = pass([store, externalSecret({ secretStoreRef: { name: "gcp" }, data: [{ secretKey: "t", remoteRef: { key: "app-token" } }] }), gcpSecret("app-token")]);
    expect(refEdges(out).map((e) => e.split(" ")[2])).toEqual(["k8s/ss-gcp", "tf/r/google_secret_manager_secret.token"]);
  });

  it("puts the key in dangling, with the holder and the store it was read through, when no secret has it", () => {
    const out = pass([gcpStore(), externalSecret(uses("gcp", "other-token")), gcpSecret("app-token")]);
    expect(refEdges(out)).toEqual([`k8s/es-app-creds -> k8s/cs-gcp [secretStoreRef] ${STORE_RULE}`]);
    expect(out.dangling).toEqual([
      expect.objectContaining({ from: "k8s/es-app-creds", path: "spec.data[].remoteRef.key", value: "other-token", rule: KEY_RULE, targetKind: "google_secret_manager_secret", through: "k8s/cs-gcp", member: "k8s" }),
    ]);
  });

  it("does not join a key to a secret of the same id in another project", () => {
    const out = pass([gcpStore(), externalSecret(uses("gcp", "app-token")), gcpSecret("app-token", "other-proj")]);
    expect(refEdges(out).filter((e) => e.includes(KEY_RULE))).toEqual([]);
    expect(out.dangling.map((d) => d.value)).toEqual(["app-token"]);
  });

  it("gives a secret whose id is a variable no edge, and counts the argument it could not read", () => {
    const secret = tf("google_secret_manager_secret.token", { secret_id: "${var.name}", project: "demo-proj" });
    const out = pass([gcpStore(), externalSecret(uses("gcp", "app-token")), secret]);
    expect(refEdges(out).filter((e) => e.includes(KEY_RULE))).toEqual([]);
    expect(out.nonLiteral).toEqual({ "tf/r/google_secret_manager_secret.token": 1 });
    expect(out.dangling.map((d) => d.value)).toEqual(["app-token"]);
  });

  it("gives a secret whose project is a variable no edge, and counts it", () => {
    const secret = tf("google_secret_manager_secret.token", { secret_id: "app-token", project: "${var.project}" });
    const out = pass([gcpStore(), externalSecret(uses("gcp", "app-token")), secret]);
    expect(refEdges(out).filter((e) => e.includes(KEY_RULE))).toEqual([]);
    expect(out.nonLiteral).toEqual({ "tf/r/google_secret_manager_secret.token": 1 });
  });

  it("reads dataFrom extract keys too, and each key once", () => {
    const spec = { secretStoreRef: { kind: "ClusterSecretStore", name: "gcp" }, data: [{ secretKey: "a", remoteRef: { key: "app-token" } }, { secretKey: "b", remoteRef: { key: "app-token" } }], dataFrom: [{ extract: { key: "more" } }] };
    const out = pass([gcpStore(), externalSecret(spec), gcpSecret("app-token"), gcpSecret("more", "demo-proj", "google_secret_manager_secret.more")]);
    expect(refEdges(out).filter((e) => !e.includes(STORE_RULE)).map((e) => e.split(" ").slice(2).join(" "))).toEqual([
      `tf/r/google_secret_manager_secret.more [remoteRef.key via gcp] ${FROM_RULE}`,
      `tf/r/google_secret_manager_secret.token [remoteRef.key via gcp] ${KEY_RULE}`,
    ]);
  });

  it("joins an AWS Secrets Manager store to aws_secretsmanager_secret by name, and by region when the secret sets one", () => {
    const store = k8s("cs-aws", CSS, { metadata: { name: "aws" }, spec: { provider: { aws: { service: "SecretsManager", region: "eu-west-1" } } } });
    const es = externalSecret(uses("aws", "prod/db"));
    const bare = tf("aws_secretsmanager_secret.db", { name: "prod/db" });
    const keyed = (out: ReturnType<typeof pass>) => refEdges(out).filter((e) => e.includes(KEY_RULE)).map((e) => e.split(" ")[2]);
    expect(keyed(pass([store, es, bare]))).toEqual(["tf/r/aws_secretsmanager_secret.db"]);
    expect(keyed(pass([store, es, tf("aws_secretsmanager_secret.db", { name: "prod/db", region: "eu-west-1" })]))).toEqual(["tf/r/aws_secretsmanager_secret.db"]);
    expect(keyed(pass([store, es, tf("aws_secretsmanager_secret.db", { name: "prod/db", region: "us-east-1" })]))).toEqual([]);
    const parameterStore = k8s("cs-aws", CSS, { metadata: { name: "aws" }, spec: { provider: { aws: { service: "ParameterStore", region: "eu-west-1" } } } });
    expect(keyed(pass([parameterStore, es, bare]))).toEqual([]);
  });

  it("reads no key through a store whose provider it does not know, and still draws the store edge", () => {
    const vault = k8s("cs-vault", CSS, { metadata: { name: "vault" }, spec: { provider: { vault: { server: "https://vault" } } } });
    const out = pass([vault, externalSecret(uses("vault", "app-token")), gcpSecret("app-token")]);
    expect(refEdges(out).map((e) => e.split(" ")[2])).toEqual(["k8s/cs-vault"]);
    expect(out.dangling).toEqual([]);
  });

  it("reports a store two members both declare as ambiguous, and reads no key through it", () => {
    const out = pass([gcpStore(), { ...gcpStore(), id: "other/cs-gcp", member: "other" }, externalSecret(uses("gcp", "app-token")), gcpSecret("app-token")]);
    expect(refEdges(out)).toEqual([]);
    expect(out.ambiguous).toEqual([expect.objectContaining({ rule: STORE_RULE, value: "gcp", candidates: ["k8s/cs-gcp", "other/cs-gcp"] })]);
  });
});
