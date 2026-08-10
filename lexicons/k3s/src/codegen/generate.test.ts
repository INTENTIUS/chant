import { describe, expect, test } from "vitest";
import { extractFlagLiterals, extractFlagList, parseSpecFiles } from "./parse";

const SERVER_GO = `package cmds

import "github.com/urfave/cli/v2"

var ServerFlags = []cli.Flag{
	ConfigFlag,
	DebugFlag,
	&cli.IntFlag{
		Name:        "https-listen-port",
		Usage:       "(listener) HTTPS listen port",
		Value:       6443,
		Destination: &ServerConfig.HTTPSPort,
	},
	&cli.StringFlag{
		Name:        "token",
		Aliases:     []string{"t"},
		Usage:       "(cluster) Shared secret used to join a server or agent to a cluster",
		EnvVars:     []string{"K3S_TOKEN"},
	},
	&cli.StringFlag{
		Name:  "token-file",
		Usage: "(cluster) File containing the token",
	},
	&cli.StringSliceFlag{
		Name:  "tls-san",
		Usage: "(listener) Add additional hostnames or IPv4/IPv6 addresses as Subject Alternative Names on the server TLS cert",
	},
	&cli.BoolFlag{
		Name:   "secret-thing",
		Usage:  "internal",
		Hidden: true,
	},
	&cli.StringFlag{
		Name:  "old-thing",
		Usage: "(deprecated) do not use",
	},
	UnknownSharedFlag,
}
`;

const AGENT_GO = `package cmds

import "github.com/urfave/cli/v2"

var (
	NodeNameFlag = &cli.StringFlag{
		Name:        "node-name",
		Usage:       "(agent/node) Node name",
		EnvVars:     []string{"K3S_NODE_NAME"},
	}
)

func NewAgentCommand() *cli.Command {
	return &cli.Command{
		Name: "agent",
		Flags: []cli.Flag{
			ConfigFlag,
			NodeNameFlag,
			&cli.StringFlag{
				Name:  "server",
				Usage: "(cluster) Server to connect to",
			},
		},
	}
}
`;

const CONFIG_GO = `package cmds

var (
	ConfigFlag = &cli.StringFlag{
		Name:  "config",
		Usage: "(config) Load configuration from FILE",
		Value: "/etc/rancher/k3s/config.yaml",
	}
	DebugFlag = &cli.BoolFlag{
		Name:  "debug",
		Usage: "(logging) Turn on debug logs",
	}
)
`;

function envelope(): string {
  return JSON.stringify({ "server.go": SERVER_GO, "agent.go": AGENT_GO, "config.go": CONFIG_GO });
}

describe("k3s flag parser", () => {
  test("extracts named flag vars with type, usage and default", () => {
    const { byVar } = extractFlagLiterals(CONFIG_GO);
    const debug = byVar.get("DebugFlag");
    expect(debug?.flagType).toBe("Bool");
    expect(debug?.name).toBe("debug");
    expect(debug?.usage).toContain("debug logs");
  });

  test("extracts a flag list mixing references and inline literals in order", () => {
    const items = extractFlagList(SERVER_GO, "var ServerFlags = []cli.Flag{");
    expect(items[0]).toBe("ConfigFlag");
    expect(items[1]).toBe("DebugFlag");
    expect(typeof items[2]).toBe("object");
  });

  test("parses the envelope into Server, Agent and the registries entities", () => {
    const results = parseSpecFiles(envelope());
    const names = results.map((r) => r.resource.typeName);
    expect(names).toEqual([
      "K3s::Server",
      "K3s::Agent",
      "K3s::Registries",
      "K3s::Mirror",
      "K3s::RegistryConfig",
      "K3s::RegistryAuth",
      "K3s::RegistryTLS",
    ]);
  });

  test("drops secrets, hidden, deprecated and the config flag itself; keeps the rest", () => {
    const server = parseSpecFiles(envelope())[0].resource;
    const names = server.properties.map((p) => p.name);
    expect(names).not.toContain("token");
    expect(names).not.toContain("config");
    expect(names).not.toContain("secret-thing");
    expect(names).not.toContain("old-thing");
    expect(names).toContain("token-file");
    expect(names).toContain("debug");
  });

  test("maps flag types to TS types, slices accepting single-or-list", () => {
    const server = parseSpecFiles(envelope())[0].resource;
    const byName = new Map(server.properties.map((p) => [p.name, p]));
    expect(byName.get("https-listen-port")?.tsType).toBe("number");
    expect(byName.get("tls-san")?.tsType).toBe("string | string[]");
    expect(byName.get("debug")?.tsType).toBe("boolean");
  });

  test("carries the default into the description", () => {
    const server = parseSpecFiles(envelope())[0].resource;
    const port = server.properties.find((p) => p.name === "https-listen-port");
    expect(port?.description).toContain("(default: 6443)");
  });

  test("requires server on the agent, and only there", () => {
    const results = parseSpecFiles(envelope());
    const agent = results[1].resource;
    expect(agent.properties.find((p) => p.name === "server")?.required).toBe(true);
    const server = results[0].resource;
    expect(server.properties.every((p) => !p.required)).toBe(true);
  });

  test("surfaces unresolved references as warnings instead of dropping them silently", () => {
    const results = parseSpecFiles(envelope());
    expect(results[0].warnings).toEqual(["ServerFlags: unresolved flag reference UnknownSharedFlag"]);
  });
});
