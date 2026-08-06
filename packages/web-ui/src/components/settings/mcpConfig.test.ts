import { describe, expect, it } from "vitest";
import {
  emptyMcpServerDraft,
  MCP_SERVER_TEMPLATES,
  parseMcpServersJson,
  removeMcpServer,
  setMcpServerEnabled,
  stringifyMcpServersJson,
  upsertMcpServer,
} from "./mcpConfig";

const sampleJson = `{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "/usr/local/bin/mcp-server-fs",
      "args": ["serve", "--transport", "stdio"],
      "env": { "ROOT": "/tmp" },
      "enabled": true
    }
  }
}`;

const httpJson = `{
  "mcpServers": {
    "remote": {
      "transport": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer tok" },
      "enabled": true
    }
  }
}`;

describe("mcpConfig", () => {
  it("parses mcpServers object shape", () => {
    const list = parseMcpServersJson(sampleJson);
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("filesystem");
    expect(list[0]?.transport).toBe("stdio");
    expect(list[0]?.command).toContain("mcp-server-fs");
    expect(list[0]?.args).toEqual(["serve", "--transport", "stdio"]);
    expect(list[0]?.env).toEqual([{ key: "ROOT", value: "/tmp" }]);
    expect(list[0]?.enabled).toBe(true);
  });

  it("parses streamable-http servers", () => {
    const list = parseMcpServersJson(httpJson);
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("remote");
    expect(list[0]?.transport).toBe("streamable-http");
    expect(list[0]?.url).toBe("https://mcp.example.com/mcp");
    expect(list[0]?.headers).toEqual([{ key: "Authorization", value: "Bearer tok" }]);
  });

  it("preserves browser permission profiles", () => {
    const list = parseMcpServersJson(JSON.stringify({
      mcpServers: {
        playwright: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@playwright/mcp"],
          browserPermissionProfile: "download",
        },
      },
    }));
    expect(list[0]?.browserPermissionProfile).toBe("download");
    expect(parseMcpServersJson(stringifyMcpServersJson(list))[0]?.browserPermissionProfile).toBe("download");
  });

  it("infers streamable-http from url-only config", () => {
    const list = parseMcpServersJson(
      JSON.stringify({
        mcpServers: {
          cloud: { url: "https://api.example.com/mcp" },
        },
      }),
    );
    expect(list[0]?.transport).toBe("streamable-http");
    expect(list[0]?.url).toBe("https://api.example.com/mcp");
  });

  it("round-trips through stringify for stdio and http", () => {
    const list = [
      ...parseMcpServersJson(sampleJson),
      ...parseMcpServersJson(httpJson),
    ];
    const again = parseMcpServersJson(stringifyMcpServersJson(list));
    expect(again).toEqual(list);
  });

  it("toggles enabled and removes servers", () => {
    let list = parseMcpServersJson(sampleJson);
    list = setMcpServerEnabled(list, "filesystem", false);
    expect(list[0]?.enabled).toBe(false);
    list = removeMcpServer(list, "filesystem");
    expect(list).toHaveLength(0);
    expect(stringifyMcpServersJson(list)).toBe("");
  });

  it("upserts new and renames existing", () => {
    let list = parseMcpServersJson(sampleJson);
    list = upsertMcpServer(list, {
      ...emptyMcpServerDraft(),
      name: "node_repl",
      command: "npx",
      args: ["-y", "some-mcp"],
      enabled: true,
    });
    expect(list.map((s) => s.name).sort()).toEqual(["filesystem", "node_repl"]);

    list = upsertMcpServer(
      list,
      {
        ...emptyMcpServerDraft(),
        name: "filesystem2",
        command: "/usr/local/bin/mcp-server-fs",
        enabled: true,
      },
      "filesystem",
    );
    expect(list.map((s) => s.name).sort()).toEqual(["filesystem2", "node_repl"]);
  });

  it("rejects empty name/command/url", () => {
    expect(() =>
      upsertMcpServer([], { ...emptyMcpServerDraft(), name: "", command: "x" }),
    ).toThrow(/名称/);
    expect(() =>
      upsertMcpServer([], { ...emptyMcpServerDraft(), name: "a", command: "  " }),
    ).toThrow(/命令/);
    expect(() =>
      upsertMcpServer([], {
        ...emptyMcpServerDraft("streamable-http"),
        name: "remote",
        url: "  ",
      }),
    ).toThrow(/URL/);
  });

  it("keeps recommended templates disabled until the user confirms them", () => {
    expect(MCP_SERVER_TEMPLATES).toHaveLength(3);
    for (const template of MCP_SERVER_TEMPLATES) {
      const draft = template.createDraft();
      expect(draft.enabled).toBe(false);
      expect(draft.riskLevel).toBe("caution");
      expect(draft.name).toBeTruthy();
    }
    expect(MCP_SERVER_TEMPLATES[0]?.createDraft().args).toContain("@modelcontextprotocol/server-filesystem");
    expect(MCP_SERVER_TEMPLATES[2]?.createDraft().transport).toBe("streamable-http");
  });
});
