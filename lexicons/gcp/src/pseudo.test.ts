import { describe, it, expect } from "bun:test";
import { GCP, ProjectId, Region, Zone, PseudoParameter } from "./pseudo";

describe("GCP pseudo-parameters", () => {
  it("ProjectId toJSON returns Ref object", () => {
    expect(ProjectId.toJSON()).toEqual({ Ref: "GCP::ProjectId" });
  });

  it("Region toJSON returns Ref object", () => {
    expect(Region.toJSON()).toEqual({ Ref: "GCP::Region" });
  });

  it("Zone toJSON returns Ref object", () => {
    expect(Zone.toJSON()).toEqual({ Ref: "GCP::Zone" });
  });

  it("ProjectId toString returns interpolation syntax", () => {
    expect(ProjectId.toString()).toBe("${GCP::ProjectId}");
  });

  it("Region toString returns interpolation syntax", () => {
    expect(Region.toString()).toBe("${GCP::Region}");
  });

  it("Zone toString returns interpolation syntax", () => {
    expect(Zone.toString()).toBe("${GCP::Zone}");
  });

  it("all pseudo-parameters are instances of PseudoParameter", () => {
    expect(ProjectId).toBeInstanceOf(PseudoParameter);
    expect(Region).toBeInstanceOf(PseudoParameter);
    expect(Zone).toBeInstanceOf(PseudoParameter);
  });

  it("GCP namespace contains all pseudo-parameters", () => {
    expect(GCP.ProjectId).toBe(ProjectId);
    expect(GCP.Region).toBe(Region);
    expect(GCP.Zone).toBe(Zone);
  });
});
