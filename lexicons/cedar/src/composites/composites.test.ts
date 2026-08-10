/**
 * Props, types and defaults for the two composites — plus the thing that
 * matters more: what they serialize to, checked against cedar-wasm.
 *
 * A composite that produces the right `props` object and the wrong Cedar text
 * is still broken, and the serializer is the only place the two meet.
 */

import { describe, expect, it } from "vitest";
import { checkParsePolicySet, getValidRequestEnvsPolicy } from "@cedar-policy/cedar-wasm/nodejs";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { Declarable } from "@intentius/chant/declarable";
import { DenyByDefaultSet, OwnerCanManage } from "./index";
import { cedarSerializer } from "../serializer";
import { DeleteAction, ReadAction, WriteAction } from "../generated/index";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const schema = readFileSync(join(pkgDir, "src", "spec", "default-schema.cedarschema"), "utf-8");

function props(entity: Declarable): Record<string, unknown> {
  return (entity as unknown as { props: Record<string, unknown> }).props;
}

/** Serialize a named set of policies to `.cedar` text. */
function emit(entities: Record<string, Declarable>): string {
  const map = new Map<string, Declarable>(Object.entries(entities));
  const result = cedarSerializer.serialize(map);
  return typeof result === "string" ? result : result.primary;
}

describe("OwnerCanManage", () => {
  it("pins the resource scope and the ownership guard together", () => {
    const p = props(OwnerCanManage({ entityType: "App::Document", actions: ReadAction }));

    expect(p.effect).toBe("permit");
    expect(p.resource).toEqual({ is: "App::Document" });
    expect(p.when).toEqual(["resource.owner == principal"]);
  });

  it("defaults the owner attribute to `owner` and takes an override", () => {
    expect(props(OwnerCanManage({ entityType: "App::Folder" })).when).toEqual([
      "resource.owner == principal",
    ]);

    expect(
      props(OwnerCanManage({ entityType: "App::Folder", ownerAttribute: "custodian" })).when,
    ).toEqual(["resource.custodian == principal"]);
  });

  it("emits `==` for one action and `in` for several", () => {
    expect(props(OwnerCanManage({ entityType: "App::Document", actions: ReadAction })).action).toEqual({
      eq: ReadAction,
    });
    expect(props(OwnerCanManage({ entityType: "App::Document", actions: [ReadAction] })).action).toEqual({
      eq: ReadAction,
    });
    expect(
      props(OwnerCanManage({ entityType: "App::Document", actions: [ReadAction, WriteAction] })).action,
    ).toEqual({ in: [ReadAction, WriteAction] });
  });

  it("leaves the action position unconstrained only when actions are omitted", () => {
    expect(props(OwnerCanManage({ entityType: "App::Document" })).action).toEqual({});
  });

  it("widens the principal to anyone by default and narrows on request", () => {
    expect(props(OwnerCanManage({ entityType: "App::Document" })).principal).toEqual({});
    expect(props(OwnerCanManage({ entityType: "App::Document", principal: "App::User" })).principal).toEqual({
      is: "App::User",
    });
    expect(
      props(OwnerCanManage({ entityType: "App::Document", principal: { eq: 'App::User::"root"' } })).principal,
    ).toEqual({ eq: 'App::User::"root"' });
  });

  it("appends extra guards after the ownership test", () => {
    const p = props(
      OwnerCanManage({
        entityType: "App::Document",
        actions: WriteAction,
        when: ["context.mfa == true"],
        unless: ['resource.classification == "confidential"'],
      }),
    );

    expect(p.when).toEqual(["resource.owner == principal", "context.mfa == true"]);
    expect(p.unless).toEqual(['resource.classification == "confidential"']);
  });

  it("omits `unless` entirely when none is asked for", () => {
    expect("unless" in props(OwnerCanManage({ entityType: "App::Document" }))).toBe(false);
  });

  it("annotates its provenance and lets the caller override the id", () => {
    const p = props(
      OwnerCanManage({ entityType: "App::Document", annotations: { id: "doc-owner", team: "docs" } }),
    );

    expect(p.annotations).toEqual({
      composite: "OwnerCanManage",
      scopedTo: "App::Document",
      id: "doc-owner",
      team: "docs",
    });
  });

  it("serializes to Cedar that parses and resolves to the intended envelope", () => {
    const text = emit({
      docOwnerRead: OwnerCanManage({
        entityType: "App::Document",
        actions: [ReadAction, WriteAction],
        principal: "App::User",
      }),
    });

    expect(text).toContain("permit (");
    expect(text).toContain("resource is App::Document");
    expect(checkParsePolicySet({ staticPolicies: text }).type).toBe("success");

    const envs = getValidRequestEnvsPolicy(text.trim(), schema);
    expect(envs.type).toBe("success");
    if (envs.type === "success") {
      expect(envs.principals).toEqual(["App::User"]);
      expect(envs.resources).toEqual(["App::Document"]);
      expect(envs.actions.sort()).toEqual([ReadAction, WriteAction].sort());
    }
  });
});

describe("DenyByDefaultSet", () => {
  const member = OwnerCanManage({ entityType: "App::Document", actions: ReadAction });

  it("returns the floor first, the members unchanged, and both in `all`", () => {
    const set = DenyByDefaultSet({
      policies: [member],
      entityType: "App::Document",
      when: ['resource.classification == "secret"'],
    });

    expect(props(set.floor).effect).toBe("forbid");
    expect(set.members).toEqual([member]);
    expect(set.all[0]).toBe(set.floor);
    expect(set.all).toHaveLength(2);
  });

  it("does not mutate the caller's array", () => {
    const policies = [member];
    const set = DenyByDefaultSet({ policies, when: ["context.mfa == false"] });

    expect(set.members).not.toBe(policies);
    expect(policies).toHaveLength(1);
  });

  it("defaults both the resource and the action position to unconstrained", () => {
    const p = props(DenyByDefaultSet({ policies: [], when: ["context.mfa == false"] }).floor);

    expect(p.resource).toEqual({});
    expect(p.action).toEqual({});
    expect(p.principal).toEqual({});
  });

  it("narrows on entityType, actions and principal", () => {
    const p = props(
      DenyByDefaultSet({
        policies: [],
        entityType: "App::Document",
        actions: [DeleteAction, WriteAction],
        principal: "App::User",
        when: ['resource.classification == "confidential"'],
        unless: ['principal == App::User::"archivist"'],
      }).floor,
    );

    expect(p.resource).toEqual({ is: "App::Document" });
    expect(p.action).toEqual({ in: [DeleteAction, WriteAction] });
    expect(p.principal).toEqual({ is: "App::User" });
    expect(p.unless).toEqual(['principal == App::User::"archivist"']);
  });

  it("records the member count and the composite name in annotations", () => {
    const set = DenyByDefaultSet({ policies: [member, member], when: ["context.mfa == false"] });

    expect(props(set.floor).annotations).toEqual({ composite: "DenyByDefaultSet", members: "2" });
  });

  it("refuses an unguarded forbid", () => {
    expect(() => DenyByDefaultSet({ policies: [member], when: [] })).toThrow(/at least one condition/);
  });

  it("serializes floor-then-members as Cedar that parses", () => {
    const set = DenyByDefaultSet({
      policies: [member],
      entityType: "App::Document",
      when: ['resource.classification == "confidential"'],
      unless: ["context.mfa == true"],
    });

    const text = emit({ secretFloor: set.floor, docOwnerRead: set.members[0] });

    expect(text.indexOf("forbid (")).toBeLessThan(text.indexOf("permit ("));
    expect(text).toContain("unless { context.mfa == true }");
    expect(checkParsePolicySet({ staticPolicies: text }).type).toBe("success");
  });
});
