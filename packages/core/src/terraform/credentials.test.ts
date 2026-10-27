// The token lookup Terraform and OpenTofu use (chant#4563): TF_TOKEN_<host> first, then the CLI config
// file and credentials.tfrc.json.
import { describe, expect, it } from "vitest";
import { authorizationFor, credentialsHost, credentialsFilePath, terraformCredential, terraformToken, tokenVariable } from "./credentials";

const files = (map: Record<string, string>) => (path: string) => map[path];

describe("tokenVariable", () => {
  it("writes dots as _ and dashes as __, lower case", () => {
    expect(tokenVariable("app.terraform.io")).toBe("TF_TOKEN_app_terraform_io");
    expect(tokenVariable("My-Registry.Example.com")).toBe("TF_TOKEN_my__registry_example_com");
  });

  it("uses punycode for an internationalised host", () => {
    expect(tokenVariable("bücher.example")).toBe("TF_TOKEN_xn____bcher__kva_example");
  });

  it("drops port 443 and has no variable for another port", () => {
    expect(credentialsHost("registry.example.com:443")).toBe("registry.example.com");
    expect(tokenVariable("127.0.0.1:8443")).toBeUndefined();
    expect(credentialsHost("https://Registry.Example.com/v1/modules/")).toBe("registry.example.com");
  });
});

describe("terraformCredential", () => {
  const home = "/home/u";
  const tfrc = "/home/u/.terraform.d/credentials.tfrc.json";

  it("reads TF_TOKEN_<host>", () => {
    expect(terraformCredential("app.terraform.io", { env: { TF_TOKEN_app_terraform_io: "t1" }, readFile: files({}) })).toEqual({ token: "t1", from: "TF_TOKEN_app_terraform_io" });
  });

  it("matches a variable whose name decodes to the host in another case", () => {
    expect(terraformToken("app.terraform.io", { env: { TF_TOKEN_App_Terraform_Io: "t2" }, readFile: files({}) })).toBe("t2");
  });

  it("reads credentials.tfrc.json under HOME", () => {
    const c = terraformCredential("registry.example.com", { env: { HOME: home }, platform: "linux", readFile: files({ [tfrc]: JSON.stringify({ credentials: { "registry.example.com": { token: "f1" } } }) }) });
    expect(c).toEqual({ token: "f1", from: tfrc });
  });

  it("reads a host with a port from the file only", () => {
    const readFile = files({ [tfrc]: JSON.stringify({ credentials: { "127.0.0.1:8443": { token: "p1" } } }) });
    expect(terraformToken("127.0.0.1:8443", { env: { HOME: home }, platform: "linux", readFile })).toBe("p1");
  });

  it("reads a credentials block from the HCL file TF_CLI_CONFIG_FILE names", () => {
    const cli = "/etc/tf/cli.tfrc";
    const text = `# comment\nplugin_cache_dir = "/tmp"\ncredentials "registry.example.com" {\n  token = "h1"\n}\n`;
    expect(terraformCredential("registry.example.com", { env: { TF_CLI_CONFIG_FILE: cli }, readFile: files({ [cli]: text }) })).toEqual({ token: "h1", from: cli });
  });

  it("lets the variable win over both files", () => {
    const cli = "/etc/tf/cli.tfrc";
    const readFile = files({
      [cli]: `credentials "registry.example.com" { token = "h1" }`,
      [tfrc]: JSON.stringify({ credentials: { "registry.example.com": { token: "f1" } } }),
    });
    expect(terraformToken("registry.example.com", { env: { HOME: home, TF_CLI_CONFIG_FILE: cli, TF_TOKEN_registry_example_com: "e1" }, platform: "linux", readFile })).toBe("e1");
    expect(terraformToken("registry.example.com", { env: { HOME: home, TF_CLI_CONFIG_FILE: cli }, platform: "linux", readFile })).toBe("h1");
  });

  it("finds nothing without a variable, a home or a config file", () => {
    expect(terraformCredential("registry.example.com", { env: {}, readFile: files({}) })).toBeUndefined();
    expect(credentialsFilePath({ env: {}, platform: "linux" })).toBeUndefined();
    expect(credentialsFilePath({ env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, platform: "win32" })).toContain("terraform.d");
  });

  it("skips a file that is neither JSON nor holds a block for the host", () => {
    expect(terraformToken("registry.example.com", { env: { HOME: home }, platform: "linux", readFile: files({ [tfrc]: "{not json" }) })).toBeUndefined();
  });

  it("builds the Authorization header, or none", () => {
    expect(authorizationFor("app.terraform.io", { env: { TF_TOKEN_app_terraform_io: "t1" }, readFile: files({}) })).toEqual({ Authorization: "Bearer t1" });
    expect(authorizationFor("app.terraform.io", { env: {}, readFile: files({}) })).toEqual({});
  });
});
