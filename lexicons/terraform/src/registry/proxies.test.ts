/**
 * Proxy source forms (chant#4606): module and provider sources written
 * through an Artifactory remote repository or a Nexus proxy host block
 * compare equal to the plain upstream source, and the registry reader reads
 * a plain source through a fake proxy. No request leaves the process.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  artifactoryProxy,
  moduleSourceForms,
  moduleThroughProxy,
  nexusProxy,
  normalizeModuleSource,
  providerAddress,
  providerAddressForms,
  providerThroughProxy,
  proxyRoute,
  registryLocation,
  registryVersions,
} from "./index";
import { usedSources } from "../used-sources";
import { createFakeArtifactory } from "./targets/fake-artifactory";
import { createFakeNexus } from "./targets/fake-nexus";
import { moduleTarball } from "./targets/fake-http";
import { moduleZip } from "./targets/zip";
import { archiveContent } from "./targets/module-target";

const AF = artifactoryProxy("acme.jfrog.io", "tf-remote");
const NX = nexusProxy({ url: "https://nexus.example.com", repo: "tf-proxy" });
const NX_LABEL = nexusProxy({ url: "https://nexus.example.com", repo: "tf-group", host: "nexus-tf" });
const proxies = [AF, NX_LABEL];

describe("module forms through a proxy", () => {
  test("an Artifactory remote source stands for the upstream module", () => {
    const src = "acme.jfrog.io/tf-remote__terraform-aws-modules/vpc/aws?ref=x";
    expect(moduleThroughProxy(src, proxies)).toEqual({ proxy: AF, upstream: "registry.terraform.io/terraform-aws-modules/vpc/aws" });
    expect(moduleSourceForms(src, { proxies })).toEqual([
      "acme.jfrog.io/tf-remote__terraform-aws-modules/vpc/aws",
      "registry.terraform.io/terraform-aws-modules/vpc/aws",
      "terraform-aws-modules/vpc/aws",
      "registry.opentofu.org/terraform-aws-modules/vpc/aws",
    ]);
    expect(normalizeModuleSource(src.split("?")[0]!, { proxies })).toBe(normalizeModuleSource("terraform-aws-modules/vpc/aws"));
  });

  test("keeps a subdirectory and takes the repository key in any case", () => {
    expect(moduleThroughProxy("ACME.jfrog.io/TF-Remote__acme/vpc/aws//modules/sub", proxies)?.upstream).toBe("registry.terraform.io/acme/vpc/aws//modules/sub");
  });

  test("a namespace without the repository's prefix, or another repository, is no proxy source", () => {
    expect(moduleThroughProxy("acme.jfrog.io/terraform-local__acme/vpc/aws", proxies)).toBeUndefined();
    expect(moduleThroughProxy("acme.jfrog.io/acme/vpc/aws", proxies)).toBeUndefined();
    expect(moduleSourceForms("acme.jfrog.io/acme/vpc/aws", { proxies })).toEqual(["acme.jfrog.io/acme/vpc/aws"]);
  });

  test("a Nexus host block label stands for its upstream, and one named for the upstream is the plain source", () => {
    expect(moduleThroughProxy("nexus-tf/acme/vpc/aws", proxies)?.upstream).toBe("registry.terraform.io/acme/vpc/aws");
    expect(normalizeModuleSource("nexus-tf/acme/vpc/aws", { proxies })).toBe("registry.terraform.io/acme/vpc/aws");
    expect(moduleThroughProxy("registry.terraform.io/acme/vpc/aws", [NX])?.upstream).toBe("registry.terraform.io/acme/vpc/aws");
  });

  test("a proxy for another upstream maps to that upstream", () => {
    const tofu = artifactoryProxy("acme.jfrog.io", "tofu-remote", "registry.opentofu.org");
    expect(normalizeModuleSource("acme.jfrog.io/tofu-remote__acme/vpc/aws", { proxies: [tofu] })).toBe("registry.opentofu.org/acme/vpc/aws");
  });

  test("without proxies nothing changes", () => {
    expect(moduleSourceForms("acme.jfrog.io/tf-remote__acme/vpc/aws")).toEqual(["acme.jfrog.io/tf-remote__acme/vpc/aws"]);
  });
});

describe("provider forms through a proxy", () => {
  test("an Artifactory remote provider stands for the upstream provider", () => {
    expect(providerThroughProxy("acme.jfrog.io/tf-remote__hashicorp/aws", proxies)?.upstream).toBe("registry.terraform.io/hashicorp/aws");
    expect(providerAddress("acme.jfrog.io/tf-remote__hashicorp/AWS", { proxies })).toBe("registry.terraform.io/hashicorp/aws");
    expect(providerAddress("acme.jfrog.io/tf-remote__hashicorp/aws", { binary: "tofu", proxies })).toBe("registry.terraform.io/hashicorp/aws");
    expect(providerAddressForms("acme.jfrog.io/tf-remote__hashicorp/aws", { proxies })).toEqual([
      "acme.jfrog.io/tf-remote__hashicorp/aws",
      "registry.terraform.io/hashicorp/aws",
      "hashicorp/aws",
      "registry.opentofu.org/hashicorp/aws",
    ]);
  });

  test("a Nexus label provider stands for the upstream provider", () => {
    expect(providerAddress("nexus-tf/hashicorp/aws", { proxies })).toBe("registry.terraform.io/hashicorp/aws");
  });

  test("an address through no proxy is read as before", () => {
    expect(providerAddress("acme.jfrog.io/acme/thing", { proxies })).toBe("acme.jfrog.io/acme/thing");
    expect(providerAddress("hashicorp/aws", { proxies })).toBe("registry.terraform.io/hashicorp/aws");
  });
});

describe("proxy routes", () => {
  test("an upstream module goes to the proxy's host and namespace", () => {
    expect(proxyRoute({ host: "registry.terraform.io", namespace: "acme" }, [AF])).toEqual({ proxy: AF, host: "acme.jfrog.io", namespace: "tf-remote__acme" });
    expect(proxyRoute({ host: "registry.terraform.io", namespace: "acme" }, [NX])).toEqual({ proxy: NX, host: "registry.terraform.io", namespace: "acme", modules: "https://nexus.example.com/repository/tf-proxy/v1/modules/" });
    expect(proxyRoute({ host: "registry.acme.dev", namespace: "acme" }, [AF])).toBeUndefined();
  });
});

describe("reads through a fake proxy", () => {
  const archive = moduleTarball({ "main.tf": "# vpc\n" });
  const zip = moduleZip(archive, archiveContent(archive));

  test("a plain source reads its versions and location through an Artifactory remote repository", async () => {
    const af = createFakeArtifactory({ host: "acme.jfrog.io", repos: ["tf-remote"], users: { reader: "jfrog-read-0123456789" } });
    af.seed("tf-remote", "terraform-aws-modules", "vpc", "aws", "5.1.0", zip);
    const o = { proxies: [AF], fetch: af.fetch, token: "jfrog-read-0123456789" };
    expect(await registryVersions("terraform-aws-modules/vpc/aws", o)).toEqual(["5.1.0"]);
    expect(await registryVersions("registry.terraform.io/terraform-aws-modules/vpc/aws", o)).toEqual(["5.1.0"]);
    expect(await registryLocation("terraform-aws-modules/vpc/aws", "5.1.0", o)).toBe("https://acme.jfrog.io/artifactory/tf-remote/terraform-aws-modules/vpc/aws/5.1.0.zip");
    const paths = af.requests.map((r) => new URL(r.url).pathname);
    expect(paths).toContain("/artifactory/api/terraform/v1/modules/tf-remote__terraform-aws-modules/vpc/aws/versions");
    expect(af.requests.every((r) => new URL(r.url).host === "acme.jfrog.io")).toBe(true);
  });

  test("a plain source reads through a Nexus proxy repository's host block, with no discovery", async () => {
    const nx = createFakeNexus({ host: "nexus.example.com", repos: ["tf-proxy"], users: { reader: "nexus-read-0123456789" }, bearer: false });
    nx.seed("tf-proxy", "terraform-aws-modules", "vpc", "aws", "5.1.0", "vpc-5.1.0.zip", zip);
    const basic = `Basic ${Buffer.from("reader:nexus-read-0123456789").toString("base64")}`;
    const o = { proxies: [NX], fetch: nx.fetch, token: false as const, authorization: basic };
    expect(await registryVersions("terraform-aws-modules/vpc/aws", o)).toEqual(["5.1.0"]);
    expect(await registryLocation("registry.terraform.io/terraform-aws-modules/vpc/aws", "5.1.0", o)).toBe(
      "https://nexus.example.com/repository/tf-proxy/v1/modules/terraform-aws-modules/vpc/aws/5.1.0/vpc-5.1.0.zip",
    );
    expect(nx.requests.map((r) => new URL(r.url).pathname)).not.toContain("/.well-known/terraform.json");
  });

  test("a source written through a Nexus label reads through it", async () => {
    const nx = createFakeNexus({ host: "nexus.example.com", repos: ["tf-group"], users: { reader: "nexus-read-0123456789" }, bearer: false });
    nx.seed("tf-group", "acme", "vpc", "aws", "1.0.0", "vpc-1.0.0.zip", zip);
    const basic = `Basic ${Buffer.from("reader:nexus-read-0123456789").toString("base64")}`;
    expect(await registryVersions("nexus-tf/acme/vpc/aws", { proxies: [NX_LABEL], fetch: nx.fetch, token: false, authorization: basic })).toEqual(["1.0.0"]);
  });

  test("a hostless source without proxies is refused as before", async () => {
    await expect(registryVersions("acme/vpc/aws", { fetch: async () => new Response(null, { status: 500 }) })).rejects.toThrow(/not a registry source/);
  });
});

describe("usedSources through a proxy", () => {
  test("a call through an Artifactory remote repository gets the upstream's normal form", async () => {
    const root = join(import.meta.dirname, "__fixtures__", "proxied-root");
    const { used } = await usedSources(root, { proxies });
    const vpc = used.find((u) => u.block === "module.vpc")!;
    expect(vpc.source).toBe("acme.jfrog.io/tf-remote__terraform-aws-modules/vpc/aws");
    expect(vpc.normal).toBe("registry.terraform.io/terraform-aws-modules/vpc/aws");
    expect(used.find((u) => u.block === "required_providers.aws")!.normal).toBe("registry.terraform.io/hashicorp/aws");
  });
});
