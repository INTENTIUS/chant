import { describe, expect, it } from "vitest";
import { Fly, Region, OrgSlug, AppName, PseudoParameter } from "./pseudo";

describe("fly pseudo-parameters", () => {
  it("Region toJSON returns Ref object", () => {
    expect(Region.toJSON()).toEqual({ Ref: "Fly::Region" });
  });

  it("OrgSlug toJSON returns Ref object", () => {
    expect(OrgSlug.toJSON()).toEqual({ Ref: "Fly::OrgSlug" });
  });

  it("AppName toJSON returns Ref object", () => {
    expect(AppName.toJSON()).toEqual({ Ref: "Fly::AppName" });
  });

  it("Region toString returns interpolation syntax", () => {
    expect(Region.toString()).toBe("${Fly::Region}");
  });

  it("all pseudo-parameters are instances of PseudoParameter", () => {
    expect(Region).toBeInstanceOf(PseudoParameter);
    expect(OrgSlug).toBeInstanceOf(PseudoParameter);
    expect(AppName).toBeInstanceOf(PseudoParameter);
  });

  it("Fly namespace contains all pseudo-parameters", () => {
    expect(Fly.Region).toBe(Region);
    expect(Fly.OrgSlug).toBe(OrgSlug);
    expect(Fly.AppName).toBe(AppName);
  });
});
