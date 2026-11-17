/**
 * #5269: a goreleaser project's container image carried onto chant release:
 * build arguments and OCI labels with the release's version, a tag for each
 * platform's image, an archive outside goreleaser's dist, and `release init`
 * reading `dockers`/`docker_manifests` (or `dockers_v2`) into release.images
 * and an oci target.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ChantConfigSchema } from "../config";
import { PublishDeclarationSchema } from "./publish-declaration";
import { ociMovingTags, ociPlatformTags, ociTags } from "./publish-oci";
import { goreleaserImage } from "./release-init-goreleaser-images";
import { buildReleaseImages, checkImagesOutsideGoreleaser, checkReleaseImages, placeReleaseImages, releaseImageBuildCommand, ReleaseImageError, resolveReleaseImages } from "./release-images";

const D = (c: string) => `sha256:${c.repeat(64)}`;

/** mudflaps's .goreleaser.yaml before it moved onto chant release. */
const MUDFLAPS = `version: 2
project_name: mudflaps
builds:
  - id: mudflaps
    main: ./cmd/mudflaps
dockers:
  - image_templates:
      - "ghcr.io/intentius/mudflaps:{{ .Version }}-amd64"
    dockerfile: Dockerfile.goreleaser
    use: buildx
    goos: linux
    goarch: amd64
    build_flag_templates:
      - "--platform=linux/amd64"
      - "--build-arg=VERSION={{ .Version }}"
      - "--label=org.opencontainers.image.source=https://github.com/intentius/mudflaps"
      - "--label=org.opencontainers.image.version={{ .Version }}"
      - "--label=org.opencontainers.image.licenses=MIT"
  - image_templates:
      - "ghcr.io/intentius/mudflaps:{{ .Version }}-arm64"
    dockerfile: Dockerfile.goreleaser
    use: buildx
    goos: linux
    goarch: arm64
    build_flag_templates:
      - "--platform=linux/arm64"
      - "--build-arg=VERSION={{ .Version }}"
      - "--label=org.opencontainers.image.source=https://github.com/intentius/mudflaps"
      - "--label=org.opencontainers.image.version={{ .Version }}"
      - "--label=org.opencontainers.image.licenses=MIT"
docker_manifests:
  - name_template: "ghcr.io/intentius/mudflaps:{{ .Version }}"
    image_templates:
      - "ghcr.io/intentius/mudflaps:{{ .Version }}-amd64"
      - "ghcr.io/intentius/mudflaps:{{ .Version }}-arm64"
  - name_template: "ghcr.io/intentius/mudflaps:latest"
    image_templates:
      - "ghcr.io/intentius/mudflaps:{{ .Version }}-amd64"
      - "ghcr.io/intentius/mudflaps:{{ .Version }}-arm64"
`;

describe("build arguments and labels with the release's version (#5269)", () => {
  test("{label} and {version} in args and labels read the build's environment; the rest stays literal", () => {
    const cmd = releaseImageBuildCommand({
      name: "mudflaps",
      dockerfile: "Dockerfile",
      args: { VERSION: "{version}", TAG: "v{label}", PLAIN: "a b" },
      labels: { "org.opencontainers.image.version": "{version}", "org.opencontainers.image.licenses": "MIT" },
    });
    expect(cmd).toContain(' --build-arg VERSION="$CHANT_RELEASE_VERSION"');
    expect(cmd).toContain(' --build-arg TAG=v"$CHANT_RELEASE_LABEL"');
    expect(cmd).toContain(" --build-arg 'PLAIN=a b'");
    expect(cmd).toContain(' --label org.opencontainers.image.version="$CHANT_RELEASE_VERSION"');
    expect(cmd).toContain(" --label org.opencontainers.image.licenses=MIT");
    // No placeholder, no change: the args render as they always did.
    expect(releaseImageBuildCommand({ name: "x", dockerfile: "Dockerfile", args: { A: "1" } })).toContain(" --build-arg A=1 --output");
  });

  test("the build sees CHANT_RELEASE_VERSION, the label from its first digit", () => {
    const cwd = mkdtempSync(join(tmpdir(), "chant-release-image-"));
    const seen: Array<string | undefined> = [];
    buildReleaseImages({
      images: [{ name: "app", dockerfile: "Dockerfile" }],
      cwd,
      sourceDateEpoch: 1,
      label: "v1.4.0",
      env: { PATH: process.env.PATH, CHANT_RELEASE_VERSION: "stale" },
      archiveDigest: () => D("a"),
      run: (_command, o) => {
        seen.push(o.env.CHANT_RELEASE_VERSION);
        mkdirSync(join(cwd, "dist/images"), { recursive: true });
        writeFileSync(join(cwd, "dist/images/app.tar"), "");
        return 0;
      },
    });
    expect(seen).toEqual(["1.4.0"]);
  });

  test("labels: keys and one-line values are checked, and the config takes them", () => {
    expect(() => checkReleaseImages([{ name: "a", dockerfile: "Dockerfile", labels: { "bad key": "x" } }])).toThrow(/not a label key/);
    expect(() => checkReleaseImages([{ name: "a", dockerfile: "Dockerfile", labels: { k: "a\nb" } }])).toThrow(/one-line/);
    expect(ChantConfigSchema.safeParse({ release: { images: [{ name: "a", dockerfile: "Dockerfile", labels: { "org.opencontainers.image.version": "{version}" } }] } }).success).toBe(true);
  });
});

describe("an image archive outside goreleaser's dist (#5269)", () => {
  const goreleaser = [{ name: "goreleaser", goreleaser: {} }];
  test("a Dockerfile entry with no archive writes build/images/<name>.tar beside a goreleaser entry, and dist/images otherwise", () => {
    const images = [{ name: "app", dockerfile: "Dockerfile" }];
    expect(resolveReleaseImages(placeReleaseImages(images, goreleaser)).map((i) => i.archive)).toEqual(["build/images/app.tar"]);
    expect(resolveReleaseImages(placeReleaseImages(images, [{ name: "g", goreleaser: { dist: "out" } }])).map((i) => i.archive)).toEqual(["dist/images/app.tar"]);
    expect(resolveReleaseImages(placeReleaseImages(images, [])).map((i) => i.archive)).toEqual(["dist/images/app.tar"]);
  });

  test("an archive named inside the dist is refused, with the path to use", () => {
    const err = (() => {
      try {
        checkImagesOutsideGoreleaser([{ name: "app", dockerfile: "Dockerfile", archive: "dist/images/app.tar" }], goreleaser);
      } catch (e) {
        return e as ReleaseImageError;
      }
      return null;
    })();
    expect(err?.code).toBe("release-image-archive-in-dist");
    expect(err?.fix).toContain("build/images/app.tar");
    expect(() => checkImagesOutsideGoreleaser([{ name: "app", build: "make", archive: "./dist/app.tar" }], goreleaser)).toThrow(/inside dist/);
    expect(() => checkImagesOutsideGoreleaser(placeReleaseImages([{ name: "app", dockerfile: "Dockerfile" }], goreleaser), goreleaser)).not.toThrow();
  });
});

describe("a tag for each platform's image (#5269)", () => {
  const decl = (o: Record<string, unknown>) => PublishDeclarationSchema.parse({ type: "oci", image: "build/images/app.tar", repository: "ghcr.io/acme/app", ...o }) as never;
  const manifests = [
    { digest: D("a"), platform: { os: "linux", architecture: "amd64" } },
    { digest: D("b"), platform: { os: "linux", architecture: "arm64" } },
    { digest: D("c"), platform: { os: "unknown", architecture: "unknown" } },
  ];

  test("platformTags name each platform's image; an attestation entry with no platform is skipped", () => {
    expect(ociPlatformTags(decl({ platformTags: ["{version}-{arch}"] }), "v1.4.0", manifests)).toEqual([
      { tag: "1.4.0-amd64", digest: D("a") },
      { tag: "1.4.0-arm64", digest: D("b") },
    ]);
    expect(ociPlatformTags(decl({ platformTags: ["{label}-{os}-{arch}"] }), "1.4.0", manifests.slice(0, 1))).toEqual([{ tag: "1.4.0-linux-amd64", digest: D("a") }]);
    // A release with no label, or a target with none declared, tags no platform.
    expect(ociPlatformTags(decl({ platformTags: ["{label}-{arch}"] }), null, manifests)).toEqual([]);
    expect(ociPlatformTags(decl({}), "1.4.0", manifests)).toEqual([]);
  });

  test("a single image reads its platform from its config, and a variant is part of {arch}", () => {
    expect(ociPlatformTags(decl({ platformTags: ["{label}-{arch}"] }), "1.0.0", [{ digest: D("d") }], () => ({ os: "linux", architecture: "arm", variant: "v7" }))).toEqual([{ tag: "1.0.0-armv7", digest: D("d") }]);
  });

  test("two images that would take one tag are refused, and a platform tag must name the release and its arch", () => {
    const two = [
      { digest: D("a"), platform: { os: "linux", architecture: "amd64" } },
      { digest: D("b"), platform: { os: "windows", architecture: "amd64" } },
    ];
    expect(() => ociPlatformTags(decl({ platformTags: ["{label}-{arch}"] }), "1.0.0", two)).toThrow(/both tag 1.0.0-amd64/);
    expect(() => decl({ platformTags: ["latest-{arch}"] })).toThrow(/names \{arch\} and \{label\} or \{version\}/);
    expect(() => decl({ platformTags: ["{label}"] })).toThrow(/names \{arch\}/);
  });

  test("{version} in tags is the label from its first digit, and belongs to the release like {label}", () => {
    expect(ociTags(decl({ tags: ["{version}", "latest"] }), { tag: null, label: "v1.4.0" })).toEqual(["1.4.0", "latest"]);
    expect(ociMovingTags(decl({ tags: ["{version}", "latest"] }), null)).toEqual(["latest"]);
  });
});

describe("release init reads goreleaser's dockers (#5269)", () => {
  test("mudflaps's dockers and docker_manifests: one Dockerfile entry and an oci target with the same tags", () => {
    expect(goreleaserImage(MUDFLAPS)).toEqual({
      name: "mudflaps",
      repository: "ghcr.io/intentius/mudflaps",
      dockerfile: "Dockerfile.goreleaser",
      platforms: ["linux/amd64", "linux/arm64"],
      args: { VERSION: "{version}" },
      labels: { "org.opencontainers.image.source": "https://github.com/intentius/mudflaps", "org.opencontainers.image.version": "{version}", "org.opencontainers.image.licenses": "MIT" },
      tags: ["{version}", "latest"],
      platformTags: ["{version}-{arch}"],
      archive: "build/images/mudflaps.tar",
      keys: ["dockers", "docker_manifests"],
      unread: [],
    });
  });

  test("dockers_v2, and the templates and flags chant can't carry, named", () => {
    const g = goreleaserImage(`version: 2
dockers_v2:
  - images: ["ghcr.io/acme/tool"]
    tags: ["{{ .Version }}", "{{ .ShortCommit }}"]
    platforms: [linux/amd64, linux/arm64]
    build_args:
      VERSION: "{{ .Version }}"
    labels:
      org.opencontainers.image.created: "{{ .Date }}"
`)!;
    expect(g).toMatchObject({ name: "tool", repository: "ghcr.io/acme/tool", dockerfile: "Dockerfile", platforms: ["linux/amd64", "linux/arm64"], args: { VERSION: "{version}" }, labels: {}, tags: ["{version}"], keys: ["dockers_v2"] });
    expect(g.unread.join("; ")).toContain("{{ .ShortCommit }}");
    expect(g.unread.join("; ")).toContain("org.opencontainers.image.created");
    expect(goreleaserImage("version: 2\nbuilds:\n  - goos: [linux]\n")).toBeNull();
  });
});
