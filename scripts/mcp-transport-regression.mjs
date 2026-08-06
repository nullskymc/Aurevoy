#!/usr/bin/env node

/**
 * 验证 stdio / Streamable HTTP MCP 的连接测试、重载工具差异与单服务失败恢复。
 * 使用本地 fixture，不访问公网，也不把任何凭据写入配置或输出。
 */
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const tempRoot = await mkdtemp(join(tmpdir(), "aurevoy-mcp-transport-"));
let httpToolName = "http_fixture_ping";
const httpFixture = createHttpMcpFixture();
await listen(httpFixture, 0);
const httpAddress = httpFixture.address();
if (!httpAddress || typeof httpAddress === "string") throw new Error("HTTP fixture 未取得端口");

process.env.AUREVOY_TEST_BOOTSTRAP = "1";
process.env.AUREVOY_HOST = "127.0.0.1";
process.env.AUREVOY_PORT = "0";
process.env.AUREVOY_DB_PATH = join(tempRoot, "aurevoy.sqlite");
process.env.AUREVOY_WORKSPACE_DIR = tempRoot;
process.env.AUREVOY_MCP_SERVERS_JSON = JSON.stringify({
  mcpServers: {
    "stdio-fixture": {
      command: process.execPath,
      args: ["--input-type=module", "-e", stdioMcpServerCode()],
      enabled: true,
    },
    "http-fixture": {
      transport: "streamable-http",
      url: `http://127.0.0.1:${httpAddress.port}/mcp`,
      enabled: true,
    },
    "broken-http": {
      transport: "streamable-http",
      url: `http://127.0.0.1:${httpAddress.port}/missing`,
      enabled: true,
    },
  },
});

const { initializeUnifiedToolFramework } = await import("../apps/agent/dist/tool/index.js");
const mcp = await import("../apps/agent/dist/tool/mcp-integration.js");
const { config } = await import("../apps/agent/dist/config.js");
initializeUnifiedToolFramework();

try {
  await assertInitialConnections(mcp, config);

  httpToolName = "http_fixture_ping_v2";
  await mcp.reloadMcpTools();
  const reloaded = mcp.getMcpStatuses().find((status) => status.name === "http-fixture");
  assert(reloaded?.connected === true, "Streamable HTTP 重载后未保持连接");
  assert(reloaded?.changes?.added.includes(httpToolName), "重载未记录新增 HTTP 工具");
  assert(reloaded?.changes?.removed.includes("http_fixture_ping"), "重载未记录移除 HTTP 工具");

  await httpFixture.close();
  await mcp.reloadMcpTools();
  const afterFailure = new Map(mcp.getMcpStatuses().map((status) => [status.name, status]));
  assert(afterFailure.get("stdio-fixture")?.connected === true, "HTTP 失败不应拖垮 stdio MCP");
  assert(afterFailure.get("http-fixture")?.connected === false, "HTTP 失败未落到可解释的 disconnected 状态");
  assert(afterFailure.get("http-fixture")?.error, "HTTP 失败缺少诊断错误");

  console.log("MCP transport regression passed");
} finally {
  await mcp.closeMcpTools();
  if (httpFixture.listening) await httpFixture.close();
}

async function assertInitialConnections(mcp, agentConfig) {
  const summary = await mcp.initializeMcpTools();
  assert(summary.connectedServers === 2, `初次 MCP 连接数错误: ${summary.connectedServers}`);
  const statuses = new Map(mcp.getMcpStatuses().map((status) => [status.name, status]));
  assert(statuses.get("stdio-fixture")?.connected === true, "stdio MCP 未连接");
  assert(statuses.get("http-fixture")?.connected === true, "Streamable HTTP MCP 未连接");
  assert(statuses.get("broken-http")?.connected === false, "故障 HTTP MCP 不应显示已连接");

  const stdio = agentConfig.mcpServers.find((server) => server.name === "stdio-fixture");
  const http = agentConfig.mcpServers.find((server) => server.name === "http-fixture");
  assert(stdio && http, "fixture 配置未解析");
  assert((await mcp.testMcpServer(stdio)).ok === true, "stdio 连接测试失败");
  assert((await mcp.testMcpServer(http)).ok === true, "Streamable HTTP 连接测试失败");
}

function createHttpMcpFixture() {
  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readBody(request));
    const server = new Server({ name: "aurevoy-http-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{
        name: httpToolName,
        description: "local HTTP fixture tool",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ok" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
  });
}

function stdioMcpServerCode() {
  return `
    import { Server } from '@modelcontextprotocol/sdk/server/index.js';
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
    import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
    const server = new Server({ name: 'aurevoy-stdio-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'stdio_fixture_ping', description: 'local stdio fixture tool', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    await server.connect(new StdioServerTransport());
  `;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
