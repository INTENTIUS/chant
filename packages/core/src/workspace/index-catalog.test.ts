/**
 * #5245: a listed ServiceAccount's IRSA annotation and a listed
 * ExternalSecret's keys, joined to what a cloud index holds
 * (`AWS::IAM::Role`, `AWS::SecretsManager::Secret`,
 * `GCP::Secretmanager::Secret`), over one catalog pass with the cluster's
 * objects and the index's nodes side by side, as behold's joined read hands
 * them over. The aws nodes are what `chant index aws` wrote for floci.
 */
import { describe, expect, it } from "vitest";
import { EKS_ANNOTATION, k8sReferenceCatalog } from "../../../../lexicons/k8s/src/reference-catalog";
import { awsReferenceCatalog } from "../../../../lexicons/aws/src/reference-catalog";
import type { IRNode } from "../graph-ir";
import type { IndexDocument } from "../lifecycle/index-document";
import { indexedMemberNodes, runCatalogPass } from "./catalog-edges";
import type { ComposedNode } from "./compose-graph";

const SA = "K8s::Core::ServiceAccount";
const ES = "K8s::ExternalSecrets::ExternalSecret";
const CSS = "K8s::ExternalSecrets::ClusterSecretStore";
const EKS_RULE = `k8s:${SA}:${EKS_ANNOTATION}`;
const KEY_RULE = `k8s:${ES}:spec.data[].remoteRef.key`;
const CLUSTER = "kind-ladybug";

/** A cluster object as the live read lists it: the manifest tree without `apiVersion` and `kind`. */
const listed = (listedType: string, kind: string, namespace: string | undefined, name: string, attrs: Record<string, unknown>): ComposedNode => ({
  id: `kubernetes/${CLUSTER}/${namespace ?? "cluster"}/${listedType}/${name}`,
  kind,
  lexicon: "k8s",
  listedType,
  location: namespace ?? "cluster",
  member: CLUSTER,
  attrs: { metadata: { name, ...(namespace ? { namespace } : {}) }, ...attrs },
});

const sa = (name: string, roleArn: string) => {
  const n = listed("v1/ServiceAccount", SA, "app", name, {});
  (n.attrs.metadata as Record<string, unknown>).annotations = { "eks.amazonaws.com/role-arn": roleArn };
  return n;
};
const awsStore = (name: string, region: string) =>
  listed("external-secrets.io/v1/ClusterSecretStore", CSS, undefined, name, { spec: { provider: { aws: { service: "SecretsManager", region } } } });
const gcpStore = (name: string, projectID: string) => listed("external-secrets.io/v1/ClusterSecretStore", CSS, undefined, name, { spec: { provider: { gcpsm: { projectID } } } });
const externalSecret = (store: string, key: string) =>
  listed("external-secrets.io/v1/ExternalSecret", ES, "app", "app-creds", { spec: { secretStoreRef: { kind: "ClusterSecretStore", name: store }, data: [{ secretKey: "password", remoteRef: { key } }] } });

const role = (account: string, name: string, path = "/"): IRNode => {
  const arn = `arn:aws:iam::${account}:role${path}${name}`;
  return {
    id: `aws/${account}/global/AWS::IAM::Role/${name}`,
    kind: "AWS::IAM::Role",
    lexicon: "aws",
    attrs: { Path: path, RoleName: name },
    physicalId: name,
    nativeId: name,
    listedType: "AWS::IAM::Role",
    location: "global",
    facts: { cloudIds: [{ kind: "arn", value: arn }, { kind: "import-id", value: name }], observedAt: "2026-11-17T04:19:31.444Z" },
  } as IRNode;
};
const secret = (account: string, region: string, name: string, suffix: string): IRNode => {
  const arn = `arn:aws:secretsmanager:${region}:${account}:secret:${name}-${suffix}`;
  return {
    id: `aws/${account}/${region}/AWS::SecretsManager::Secret/${arn}`,
    kind: "AWS::SecretsManager::Secret",
    lexicon: "aws",
    attrs: { Name: name, RotationEnabled: false },
    physicalId: arn,
    nativeId: arn,
    listedType: "AWS::SecretsManager::Secret",
    location: region,
    facts: { cloudIds: [{ kind: "arn", value: arn }, { kind: "import-id", value: arn }], observedAt: "2026-11-17T04:19:31.482Z" },
  } as IRNode;
};
const gcpSecret = (project: string, id: string): IRNode => ({
  id: `gcp/${project}/global/secretmanager.googleapis.com/Secret///secretmanager.googleapis.com/projects/${project}/secrets/${id}`,
  kind: "GCP::Secretmanager::Secret",
  lexicon: "gcp",
  attrs: { name: `//secretmanager.googleapis.com/projects/${project}/secrets/${id}`, assetType: "secretmanager.googleapis.com/Secret", displayName: id },
  nativeId: `//secretmanager.googleapis.com/projects/${project}/secrets/${id}`,
  listedType: "secretmanager.googleapis.com/Secret",
  location: "global",
});

/** An index document as `chant index` writes it, with only what the pass reads. */
const indexDoc = (substrate: string, scopeId: string, nodes: IRNode[]): IndexDocument =>
  ({
    index: "v1",
    stamp: { scope: { kind: "cloud", substrate, scopeId }, scopeKey: `cloud/${substrate}/${scopeId}/fe73c8a16670`, observedAt: "2026-11-17T04:19:31.411Z" },
    coverage: [],
    graph: { nodes, edges: [], groups: {} },
  }) as unknown as IndexDocument;

const pass = (nodes: ComposedNode[]) =>
  runCatalogPass(nodes, [
    { lexicon: "aws", catalog: awsReferenceCatalog },
    { lexicon: "k8s", catalog: k8sReferenceCatalog },
  ]);
const refEdges = (out: ReturnType<typeof pass>) =>
  out.edges.filter((e) => e.relation === "reference" && e.from.startsWith("kubernetes/")).map((e) => `${e.from} -> ${e.to} [${e.viaAttr}] ${e.rule}`);
const ruleDangling = (out: ReturnType<typeof pass>, rule: string) => out.dangling.filter((d) => d.rule === rule);

const OWN = "000000000000";
const OTHER = "111111111111";

describe("an index's nodes in a catalog pass (#5245)", () => {
  it("places each node in the member the index's scope key names", () => {
    const nodes = indexedMemberNodes(indexDoc("aws", OWN, [role(OWN, "app-reader", "/eks/")]));
    expect(nodes.map((n) => [n.id, n.member])).toEqual([[`aws/${OWN}/global/AWS::IAM::Role/app-reader`, `cloud/aws/${OWN}/fe73c8a16670`]]);
  });
});

describe("a listed ServiceAccount to the indexed role it assumes (#5245)", () => {
  const index = indexedMemberNodes(indexDoc("aws", OWN, [role(OWN, "app-reader", "/eks/"), role(OWN, "other-role")]));

  it("joins the role whose ARN the annotation holds", () => {
    const out = pass([sa("reader", `arn:aws:iam::${OWN}:role/eks/app-reader`), ...index]);
    expect(refEdges(out)).toEqual([`kubernetes/${CLUSTER}/app/v1/ServiceAccount/reader -> aws/${OWN}/global/AWS::IAM::Role/app-reader [eks.amazonaws.com/role-arn] ${EKS_RULE}`]);
    expect(ruleDangling(out, EKS_RULE)).toEqual([]);
    expect(out.ambiguous).toEqual([]);
  });

  it("joins a role whose ARN is its `Arn` attribute when its cloud ids carry none", () => {
    const bare = { ...role(OWN, "app-reader", "/eks/"), facts: { cloudIds: [], observedAt: "x" } } as IRNode;
    const arnAttr = { ...bare, attrs: { ...bare.attrs, Arn: `arn:aws:iam::${OWN}:role/eks/app-reader` } } as IRNode;
    const out = pass([sa("reader", `arn:aws:iam::${OWN}:role/eks/app-reader`), ...indexedMemberNodes(indexDoc("aws", OWN, [arnAttr]))]);
    expect(refEdges(out)).toHaveLength(1);
  });

  it("gives a role of the same name in another account no edge, and lists the annotation as dangling", () => {
    const elsewhere = indexedMemberNodes(indexDoc("aws", OTHER, [role(OTHER, "app-reader", "/eks/")]));
    const out = pass([sa("reader", `arn:aws:iam::${OWN}:role/eks/app-reader`), ...elsewhere]);
    expect(refEdges(out)).toEqual([]);
    expect(ruleDangling(out, EKS_RULE)).toEqual([expect.objectContaining({ value: `arn:aws:iam::${OWN}:role/eks/app-reader` })]);
  });

  it("picks the role in the annotation's account when both accounts are indexed", () => {
    const elsewhere = indexedMemberNodes(indexDoc("aws", OTHER, [role(OTHER, "app-reader", "/eks/")]));
    const out = pass([sa("reader", `arn:aws:iam::${OWN}:role/eks/app-reader`), ...index, ...elsewhere]);
    expect(refEdges(out).map((e) => e.split(" -> ")[1].split(" ")[0])).toEqual([`aws/${OWN}/global/AWS::IAM::Role/app-reader`]);
    expect(out.ambiguous).toEqual([]);
  });

  it("gives a role at another path no edge", () => {
    const out = pass([sa("reader", `arn:aws:iam::${OWN}:role/other-role`), ...indexedMemberNodes(indexDoc("aws", OWN, [role(OWN, "other-role", "/team/")]))]);
    expect(refEdges(out)).toEqual([]);
  });
});

describe("a listed ExternalSecret to the indexed secret its key names (#5245)", () => {
  const index = indexedMemberNodes(indexDoc("aws", OWN, [secret(OWN, "us-east-1", "app/db-password", "7HZH6J"), secret(OWN, "eu-west-1", "app/db-password", "O24NGH")]));

  it("joins the secret of that name in the store's region", () => {
    const out = pass([awsStore("aws-sm", "us-east-1"), externalSecret("aws-sm", "app/db-password"), ...index]);
    const target = `aws/${OWN}/us-east-1/AWS::SecretsManager::Secret/arn:aws:secretsmanager:us-east-1:${OWN}:secret:app/db-password-7HZH6J`;
    expect(refEdges(out)).toEqual([
      `kubernetes/${CLUSTER}/app/external-secrets.io/v1/ExternalSecret/app-creds -> ${target} [remoteRef.key via aws-sm] ${KEY_RULE}`,
      `kubernetes/${CLUSTER}/app/external-secrets.io/v1/ExternalSecret/app-creds -> kubernetes/${CLUSTER}/cluster/external-secrets.io/v1/ClusterSecretStore/aws-sm [secretStoreRef] k8s:${ES}:spec.secretStoreRef.name`,
    ]);
    expect(ruleDangling(out, KEY_RULE)).toEqual([]);
    expect(out.ambiguous).toEqual([]);
  });

  it("joins a key that is the secret's ARN", () => {
    const arn = `arn:aws:secretsmanager:eu-west-1:${OWN}:secret:app/db-password-O24NGH`;
    const out = pass([awsStore("aws-sm", "eu-west-1"), externalSecret("aws-sm", arn), ...index]);
    expect(refEdges(out).filter((e) => e.includes(KEY_RULE))).toEqual([expect.stringContaining(`-> aws/${OWN}/eu-west-1/AWS::SecretsManager::Secret/${arn} `)]);
  });

  it("lists a key with no secret in the store's region as dangling, through the store", () => {
    const out = pass([awsStore("aws-sm", "ap-south-1"), externalSecret("aws-sm", "app/db-password"), ...index]);
    expect(refEdges(out).filter((e) => e.includes(KEY_RULE))).toEqual([]);
    expect(ruleDangling(out, KEY_RULE)).toEqual([
      expect.objectContaining({ value: "app/db-password", through: `kubernetes/${CLUSTER}/cluster/external-secrets.io/v1/ClusterSecretStore/aws-sm` }),
    ]);
  });

  it("joins a GCP secret by the store's project and the key", () => {
    const gcp = indexedMemberNodes(indexDoc("gcp", "demo-proj", [gcpSecret("demo-proj", "app-token"), gcpSecret("other-proj", "app-token")]));
    const out = pass([gcpStore("gcp", "demo-proj"), externalSecret("gcp", "app-token"), ...gcp]);
    expect(refEdges(out).filter((e) => e.includes(KEY_RULE))).toEqual([
      expect.stringContaining(`-> gcp/demo-proj/global/secretmanager.googleapis.com/Secret///secretmanager.googleapis.com/projects/demo-proj/secrets/app-token [remoteRef.key via gcp]`),
    ]);
    expect(out.ambiguous).toEqual([]);
  });
});
