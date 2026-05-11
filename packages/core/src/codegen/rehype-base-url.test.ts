import { describe, it, expect } from "vitest";
import rehypeBaseUrl from "./rehype-base-url.mjs";

type Element = {
  type: "element";
  tagName: string;
  properties: Record<string, unknown>;
  children: Element[];
};

function a(href: string): Element {
  return { type: "element", tagName: "a", properties: { href }, children: [] };
}

function tree(...links: Element[]): Element {
  return { type: "element", tagName: "root", properties: {}, children: links };
}

function run(opts: { base: string; projectBase?: string }, href: string): string {
  const plugin = rehypeBaseUrl(opts);
  const root = tree(a(href));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plugin as any)(root);
  return root.children[0].properties.href as string;
}

describe("rehypeBaseUrl — main docs (base=/chant)", () => {
  const opts = { base: "/chant", projectBase: "/chant" };

  it("prepends base to plain root-relative link", () => {
    expect(run(opts, "/lexicons/aws/")).toBe("/chant/lexicons/aws/");
  });

  it("prepends base to /api/* TypeDoc link", () => {
    expect(run(opts, "/api/classes/attrref/")).toBe("/chant/api/classes/attrref/");
  });

  it("leaves already-prefixed /chant/ link unchanged", () => {
    expect(run(opts, "/chant/concepts/philosophy/")).toBe(
      "/chant/concepts/philosophy/",
    );
  });

  it("leaves the bare base unchanged", () => {
    expect(run(opts, "/chant")).toBe("/chant");
  });

  it("leaves https://… unchanged", () => {
    expect(run(opts, "https://example.com/foo")).toBe("https://example.com/foo");
  });

  it("leaves protocol-relative // unchanged", () => {
    expect(run(opts, "//cdn.example.com/x")).toBe("//cdn.example.com/x");
  });

  it("leaves mailto: unchanged", () => {
    expect(run(opts, "mailto:a@b")).toBe("mailto:a@b");
  });

  it("leaves anchor #foo unchanged", () => {
    expect(run(opts, "#section")).toBe("#section");
  });

  it("leaves relative path unchanged", () => {
    expect(run(opts, "foo/bar")).toBe("foo/bar");
  });

  it("leaves dot-relative path unchanged", () => {
    expect(run(opts, "../sibling/")).toBe("../sibling/");
  });

  it("leaves empty href unchanged", () => {
    expect(run(opts, "")).toBe("");
  });
});

describe("rehypeBaseUrl — lexicon (base=/chant/lexicons/aws, projectBase=/chant)", () => {
  const opts = { base: "/chant/lexicons/aws", projectBase: "/chant" };

  it("leaves cross-site /chant/… unchanged (projectBase guard)", () => {
    expect(run(opts, "/chant/concepts/philosophy/")).toBe(
      "/chant/concepts/philosophy/",
    );
  });

  it("leaves cross-lexicon /chant/lexicons/k8s/… unchanged", () => {
    expect(run(opts, "/chant/lexicons/k8s/")).toBe("/chant/lexicons/k8s/");
  });

  it("leaves the lexicon's own base prefix unchanged", () => {
    expect(run(opts, "/chant/lexicons/aws/composites/")).toBe(
      "/chant/lexicons/aws/composites/",
    );
  });

  it("prepends lexicon base to bare /foo/ (interpreted as site-local)", () => {
    expect(run(opts, "/foo/bar/")).toBe("/chant/lexicons/aws/foo/bar/");
  });
});

describe("rehypeBaseUrl — base normalization", () => {
  it("is a no-op when base is '/'", () => {
    const plugin = rehypeBaseUrl({ base: "/" });
    const root = tree(a("/foo"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any)(root);
    expect(root.children[0].properties.href).toBe("/foo");
  });

  it("handles trailing slashes in base option", () => {
    expect(run({ base: "/chant/", projectBase: "/chant/" }, "/foo")).toBe(
      "/chant/foo",
    );
  });

  it("handles missing leading slash in base option", () => {
    expect(run({ base: "chant", projectBase: "chant" }, "/foo")).toBe("/chant/foo");
  });
});

describe("rehypeBaseUrl — tree traversal", () => {
  it("rewrites nested <a> hrefs", () => {
    const plugin = rehypeBaseUrl({ base: "/chant", projectBase: "/chant" });
    const root = tree();
    root.children = [
      {
        type: "element",
        tagName: "div",
        properties: {},
        children: [a("/foo"), a("/bar")],
      },
      a("/baz"),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any)(root);
    const div = root.children[0] as Element;
    expect(div.children[0].properties.href).toBe("/chant/foo");
    expect(div.children[1].properties.href).toBe("/chant/bar");
    expect(root.children[1].properties.href).toBe("/chant/baz");
  });

  it("leaves non-<a> elements alone", () => {
    const plugin = rehypeBaseUrl({ base: "/chant" });
    const root: Element = {
      type: "element",
      tagName: "root",
      properties: {},
      children: [
        {
          type: "element",
          tagName: "img",
          properties: { src: "/foo.png" },
          children: [],
        },
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any)(root);
    expect(root.children[0].properties.src).toBe("/foo.png");
  });
});
