import { join } from "node:path";
import { describe, test, expect } from "vitest";
import { nameRenderSchemas, parseRenderOpenAPI, qualifiedClassName } from "./parse";
import { NamingStrategy, publishedNames, publishedSchemaNames } from "../codegen/naming";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/**
 * A servicePOST-shaped spec: WebService's `serviceDetails` reaches `image`.
 * `newcomer` is an upstream schema the details also reach, which strips to the
 * same class name as `image`.
 */
const spec = (newcomer?: string) =>
  JSON.stringify({
    components: {
      schemas: {
        servicePOST: {
          type: "object",
          properties: { name: { type: "string" }, serviceDetails: { type: "object" } },
        },
        webServiceDetailsPOST: {
          type: "object",
          properties: {
            image: ref("image"),
            ...(newcomer ? { nextImage: ref(newcomer) } : {}),
          },
        },
        image: { type: "object", properties: { imagePath: { type: "string" }, ownerId: { type: "string" } } },
        ...(newcomer ? { [newcomer]: { type: "object", properties: { imagePath: { type: "string" } } } } : {}),
      },
    },
  });

const propertyTypes = (results: ReturnType<typeof parseRenderOpenAPI>) =>
  Object.fromEntries(results.filter((r) => r.isProperty).map((r) => [r.schema, r.resource.typeName]));

describe("published render names stay with their schemas (#5569)", () => {
  test("the committed snapshot records the schema behind each published property type", () => {
    const published = publishedSchemaNames();
    expect(published.image).toBe("Image");
    expect(published.webServiceDetailsPOST).toBe("WebServiceDetails");
    expect(publishedNames()["Render::Services::Image"]).toBe("Image");
    expect(publishedSchemaNames(join(import.meta.dirname, "no-such-dir", "surface.snapshot.json"))).toEqual({});
  });

  test("the release before the newcomer names image Image", () => {
    expect(propertyTypes(parseRenderOpenAPI(spec(), publishedSchemaNames()))).toEqual({
      webServiceDetailsPOST: "Render::Services::WebServiceDetails",
      image: "Render::Services::Image",
    });
  });

  for (const [newcomer, qualified] of [
    ["imageInput", "ImageInput"],
    ["imagePOST", "ImagePOST"],
  ]) {
    test(`a newcomer ${newcomer} keeps its suffix and the published Image stays`, () => {
      const results = parseRenderOpenAPI(spec(newcomer), publishedSchemaNames());
      expect(propertyTypes(results)).toEqual({
        webServiceDetailsPOST: "Render::Services::WebServiceDetails",
        image: "Render::Services::Image",
        [newcomer]: `Render::Services::${qualified}`,
      });
      expect(new Set(results.map((r) => r.resource.typeName)).size).toBe(results.length);

      const details = results.find((r) => r.resource.typeName === "Render::Services::WebServiceDetails")!;
      expect(details.resource.properties.find((p) => p.name === "image")?.tsType).toBe("Image");
      expect(details.resource.properties.find((p) => p.name === "nextImage")?.tsType).toBe(qualified);

      const naming = new NamingStrategy(results, publishedNames());
      expect(naming.resolve("Render::Services::Image")).toBe("Image");
      expect(naming.resolve(`Render::Services::${qualified}`)).toBe(qualified);
    });
  }

  test("the published name stays whichever schema the spec lists first", () => {
    const names = nameRenderSchemas(["imageInput", "image"], { image: "Image" });
    expect(Object.fromEntries(names)).toEqual({ imageInput: "ImageInput", image: "Image" });
  });

  test("a newcomer with no suffix to keep takes the service segment", () => {
    const names = nameRenderSchemas(["imagePOST", "image"], { imagePOST: "Image" });
    expect(Object.fromEntries(names)).toEqual({ imagePOST: "Image", image: "ServicesImage" });
  });

  test("a schema that would take a resource's name is qualified", () => {
    expect(Object.fromEntries(nameRenderSchemas(["disk"]))).toEqual({ disk: "ServicesDisk" });
  });

  test("qualifiedClassName keeps the request-shape suffix", () => {
    expect(qualifiedClassName("imageInput")).toBe("ImageInput");
    expect(qualifiedClassName("routePost")).toBe("RoutePost");
    expect(qualifiedClassName("image")).toBe("ServicesImage");
  });
});
