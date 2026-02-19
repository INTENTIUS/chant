import { describe, test, expect } from "bun:test";
import { AttrRef } from "./attrref";
import { INTRINSIC_MARKER, isIntrinsic } from "./intrinsic";

describe("AttrRef", () => {
  test("creates AttrRef with parent and attribute", () => {
    const parent = { id: "test" };
    const attrRef = new AttrRef(parent, "Arn");

    expect(attrRef).toBeInstanceOf(AttrRef);
    expect(attrRef.attribute).toBe("Arn");
    expect(attrRef.parent.deref()).toBe(parent);
  });

  test("implements Intrinsic interface", () => {
    const parent = {};
    const attrRef = new AttrRef(parent, "Name");

    expect(attrRef[INTRINSIC_MARKER]).toBe(true);
    expect(isIntrinsic(attrRef)).toBe(true);
  });

  test("stores parent as WeakRef", () => {
    const parent = { id: "test" };
    const attrRef = new AttrRef(parent, "Id");

    expect(attrRef.parent).toBeInstanceOf(WeakRef);
    expect(attrRef.parent.deref()).toBe(parent);
  });

  test("getLogicalName returns undefined before set", () => {
    const parent = {};
    const attrRef = new AttrRef(parent, "Arn");

    expect(attrRef.getLogicalName()).toBeUndefined();
  });

  test("getLogicalName returns the logical name after set", () => {
    const parent = {};
    const attrRef = new AttrRef(parent, "Arn");

    attrRef._setLogicalName("MyResource");
    expect(attrRef.getLogicalName()).toBe("MyResource");
  });

  test("_setLogicalName sets the logical name", () => {
    const parent = {};
    const attrRef = new AttrRef(parent, "Arn");

    attrRef._setLogicalName("MyResource");

    const json = attrRef.toJSON();
    expect(json).toEqual({
      __attrRef: { entity: "MyResource", attribute: "Arn" },
    });
  });

  test("toJSON returns __attrRef when logical name is set", () => {
    const parent = {};
    const attrRef = new AttrRef(parent, "DomainName");

    attrRef._setLogicalName("MyBucket");

    const json = attrRef.toJSON();
    expect(json).toEqual({
      __attrRef: { entity: "MyBucket", attribute: "DomainName" },
    });
  });

  test("toJSON throws when logical name is not set", () => {
    const parent = {};
    const attrRef = new AttrRef(parent, "Arn");

    expect(() => attrRef.toJSON()).toThrow(
      'Cannot serialize AttrRef for attribute "Arn": logical name not set'
    );
  });

  test("toJSON throws with correct attribute name in error message", () => {
    const parent = {};
    const attrRef = new AttrRef(parent, "CustomAttribute");

    expect(() => attrRef.toJSON()).toThrow(
      'Cannot serialize AttrRef for attribute "CustomAttribute": logical name not set'
    );
  });

  test("handles different attribute names", () => {
    const parent = {};
    const attributes = ["Arn", "Name", "Id", "DomainName", "PhysicalResourceId"];

    for (const attr of attributes) {
      const attrRef = new AttrRef(parent, attr);
      attrRef._setLogicalName("Resource");

      const json = attrRef.toJSON();
      expect(json).toEqual({
        __attrRef: { entity: "Resource", attribute: attr },
      });
    }
  });

  test("handles different logical names", () => {
    const parent = {};
    const logicalNames = ["MyBucket", "MyTable", "MyFunction", "My-Resource-123"];

    for (const name of logicalNames) {
      const attrRef = new AttrRef(parent, "Arn");
      attrRef._setLogicalName(name);

      const json = attrRef.toJSON();
      expect(json).toEqual({
        __attrRef: { entity: name, attribute: "Arn" },
      });
    }
  });

  test("_setLogicalName can be called multiple times", () => {
    const parent = {};
    const attrRef = new AttrRef(parent, "Arn");

    attrRef._setLogicalName("FirstName");
    expect(attrRef.toJSON()).toEqual({
      __attrRef: { entity: "FirstName", attribute: "Arn" },
    });

    attrRef._setLogicalName("SecondName");
    expect(attrRef.toJSON()).toEqual({
      __attrRef: { entity: "SecondName", attribute: "Arn" },
    });
  });

  test("maintains separate logical names for different instances", () => {
    const parent = {};
    const attrRef1 = new AttrRef(parent, "Arn");
    const attrRef2 = new AttrRef(parent, "Name");

    attrRef1._setLogicalName("Resource1");
    attrRef2._setLogicalName("Resource2");

    expect(attrRef1.toJSON()).toEqual({
      __attrRef: { entity: "Resource1", attribute: "Arn" },
    });
    expect(attrRef2.toJSON()).toEqual({
      __attrRef: { entity: "Resource2", attribute: "Name" },
    });
  });
});
