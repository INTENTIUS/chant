/**
 * The four rules module descent made possible (chant #2112): TF014 and TF015,
 * which are about what a child module may contain, and TF020 and TF021, which
 * need a whole scope's references or a resource's whole body.
 *
 * TF014, TF015 and the scoped half of TF020 read tree fixtures
 * (`fixtures/<id>/<case>/`, parsed through `renderTerraformRoots` by
 * `loadTreeFixture`), because a rule about a child module cannot be shown one
 * file and still be tested honestly. TF020's own conditions and TF021 read
 * single-file fixtures the way every rule before them does.
 */

import { describe, expect, it } from "vitest";
import { loadFixture, loadTreeFixture } from "./fixtures/load";
import { tf001 } from "./tf001";
import { tf014 } from "./tf014";
import { tf015 } from "./tf015";
import { tf020 } from "./tf020";
import { tf021 } from "./tf021";
import { withCallersChain } from "./scope";

describe("TF014: a child module configures a provider", () => {
  it("reports a provider block that sets anything beyond alias", async () => {
    const diags = tf014.check(await loadTreeFixture("TF014", "positive", "app"));
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("app/module.cdn/provider.aws");
    expect(diags[0].message).toContain("profile, region");
    expect(diags[0].message).toContain("providers = { ... }");
  });

  it("leaves an alias-only block, and the root's own provider, alone", async () => {
    const diags = tf014.check(await loadTreeFixture("TF014", "negative", "app"));
    expect(diags).toEqual([]);
  });

  it("never fires on a root module's provider block", async () => {
    // The positive fixture's ROOT configures a region too; only the child's
    // block is reported.
    const ctx = await loadTreeFixture("TF014", "positive", "app");
    expect(ctx.entities.has("app/provider.aws")).toBe(true);
    expect(tf014.check(ctx).map((d) => d.entity)).toEqual(["app/module.cdn/provider.aws"]);
  });
});

describe("TF015: a child module declares a backend or cloud block", () => {
  it("reports the backend block in the child", async () => {
    const diags = tf015.check(await loadTreeFixture("TF015", "positive", "app"));
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("app/module.cdn/terraform");
    expect(diags[0].message).toContain("declares a backend block");
    expect(diags[0].message).toContain("Only a root module may");
  });

  it("leaves a child's required_version and required_providers alone", async () => {
    expect(tf015.check(await loadTreeFixture("TF015", "negative", "app"))).toEqual([]);
  });

  it("is TF001's mirror: the root keeps its backend and neither rule fires twice", async () => {
    const ctx = await loadTreeFixture("TF015", "positive", "app");
    expect(tf001.check(ctx)).toEqual([]);
    expect(tf015.check(ctx)).toHaveLength(1);
  });
});

describe("TF001 still fires only on roots (#2112)", () => {
  it("does not report a child module that has no backend", async () => {
    // The root of the TF014 fixture declares one; the child declares none.
    const ctx = await loadTreeFixture("TF014", "positive", "app");
    expect(ctx.entities.has("app/module.cdn/aws_s3_bucket.assets")).toBe(true);
    expect(tf001.check(ctx)).toEqual([]);
  });

  it("still reports a root that has none, descent or no descent", async () => {
    const ctx = await loadTreeFixture("TF020", "scoped", "app");
    expect(tf001.check(ctx)).toEqual([]); // this root has a local backend block

    const bare = await loadFixture("TF001", "positive", "app");
    expect(tf001.check(bare)).toHaveLength(1);
  });
});

describe("TF020: a declaration nothing in its scope references", () => {
  it("reports an unused variable, local, data source and aliased provider", async () => {
    const diags = tf020.check(await loadFixture("TF020", "positive"));
    expect(diags.map((d) => d.entity).sort()).toEqual([
      "TF020/data.aws_ami.ubuntu",
      "TF020/locals",
      "TF020/provider.aws",
      "TF020/var.retention_days",
    ]);
    expect(diags.find((d) => d.entity === "TF020/locals")?.message).toContain('"local.common_tags"');
    expect(diags.find((d) => d.entity === "TF020/data.aws_ami.ubuntu")?.message).toContain("every plan");
  });

  it("does not count a variable read only by its own validation block as used", async () => {
    const diags = tf020.check(await loadFixture("TF020", "positive"));
    expect(diags.some((d) => d.message.includes('"var.retention_days"'))).toBe(true);
  });

  it("reports nothing when every declaration is referenced", async () => {
    expect(tf020.check(await loadFixture("TF020", "negative"))).toEqual([]);
  });

  it("judges each module scope on its own", async () => {
    const diags = tf020.check(await loadTreeFixture("TF020", "scoped", "app"));
    // The root's `var.region` is referenced by the module call; the child's
    // `var.unused_in_child` is referenced by nothing in the child.
    expect(diags.map((d) => d.entity)).toEqual(["app/module.cdn/var.unused_in_child"]);
  });
});

describe("TF021: count where for_each is safer", () => {
  it("reports a numeric count building an identity from count.index", async () => {
    const diags = tf021.check(await loadFixture("TF021", "positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("`count = 3`");
    expect(diags[0].message).toContain("tags.Name");
    expect(diags[0].message).toContain("for_each");
  });

  it("reports a length() count the same way", async () => {
    const diags = tf021.check(await loadFixture("TF021", "positive-length"));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("length(var.subnets)");
    expect(diags[0].message).toContain("bucket");
  });

  it("leaves a conditional count, a positional-only count.index and for_each alone", async () => {
    expect(tf021.check(await loadFixture("TF021", "negative"))).toEqual([]);
  });
});

describe("the Callers chain on a finding inside a child module", () => {
  it("names the root and every call site, with the file and line of each", async () => {
    const ctx = await loadTreeFixture("TF014", "positive", "app");
    const [wrapped] = withCallersChain([tf014]);
    const [diag] = wrapped.check(ctx);
    expect(diag.message).toContain("Callers: app -> module.cdn (main.tf:13).");
  });

  it("chains one hop per level", async () => {
    const ctx = await loadTreeFixture("TF015", "positive", "app");
    const [wrapped] = withCallersChain([tf015]);
    const [diag] = wrapped.check(ctx);
    expect(diag.message).toContain("Callers: app -> module.cdn (main.tf:11).");
  });

  it("says nothing on a finding in the root module", async () => {
    const [wrapped] = withCallersChain([tf001]);
    const [diag] = wrapped.check(await loadFixture("TF001", "positive", "app"));
    expect(diag.message).not.toContain("Callers:");
  });
});
