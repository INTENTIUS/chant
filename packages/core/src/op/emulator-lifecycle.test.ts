import { describe, test, expect } from "vitest";
import { emulatorLifecycle } from "./emulator-lifecycle";

describe("emulatorLifecycle command builders", () => {
  const emu = emulatorLifecycle({
    name: "chant-x",
    image: "org/x:1.0",
    containerPort: 4200,
    healthPath: "/_x/health",
  });

  test("runCommand uses defaults and maps host port to the container port", () => {
    expect(emu.runCommand()).toBe("docker run -d --rm --name chant-x -p 4200:4200 org/x:1.0");
  });

  test("runCommand honors name/port/image overrides (host port maps to containerPort)", () => {
    expect(emu.runCommand({ name: "x2", port: 4599, image: "org/x:2.0" })).toBe(
      "docker run -d --rm --name x2 -p 4599:4200 org/x:2.0",
    );
  });

  test("spec.runArgs and per-call extraArgs precede the image", () => {
    const e = emulatorLifecycle({
      name: "n",
      image: "img:1",
      containerPort: 80,
      healthPath: "/h",
      runArgs: ["--pull", "always"],
    });
    expect(e.runCommand({ extraArgs: ["-v", "/sock:/sock"] })).toBe(
      "docker run -d --rm --name n -p 80:80 --pull always -v /sock:/sock img:1",
    );
  });

  test("exists / rm / health / endpoint", () => {
    expect(emu.existsCommand("n")).toBe("docker ps -q -f name=n");
    expect(emu.rmCommand("n")).toBe("docker rm -f n");
    expect(emu.healthUrl(4599)).toBe("http://localhost:4599/_x/health");
    expect(emu.endpoint(4599)).toBe("http://localhost:4599");
  });
});
