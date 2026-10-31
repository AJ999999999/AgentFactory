// A minimal MCP server over stdio: JSON-RPC 2.0, one message per line, tools only. No
// SDK, so it runs on bare Node. Both of this repo's servers use it: the context layer
// for agents (src/mcp-server.ts) and the partner's harness tools (src/harness/mcp.ts).
import * as readline from "node:readline";
import type { Readable, Writable } from "node:stream";

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>) => unknown;
  // A reason this call isn't allowed, or null.
  refuse?: (args: Record<string, unknown>) => string | null;
};

export type McpResult = { text: string; data?: unknown };

export function serveMcp(info: { name: string; version: string; instructions?: string }, tools: McpTool[], io: { input?: Readable; output?: Writable } = {}): void {
  const out = io.output ?? process.stdout;
  const reply = (id: unknown, result: unknown) => out.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  const fail = (id: unknown, code: number, message: string) => out.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
  const rl = readline.createInterface({ input: io.input ?? process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      return fail(null, -32700, "parse error");
    }
    const { id, method, params = {} } = msg;
    if (method === "notifications/initialized" || id === undefined) return; // notifications get no reply
    if (method === "initialize") {
      return reply(id, {
        protocolVersion: (params.protocolVersion as string) ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, version: info.version },
        ...(info.instructions ? { instructions: info.instructions } : {}),
      });
    }
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (method === "tools/call") {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return fail(id, -32602, `unknown tool ${String(params.name)}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const no = tool.refuse?.(args);
      if (no) return reply(id, { content: [{ type: "text", text: no }], isError: true });
      try {
        const res = await tool.call(args);
        // A tool can give the model readable text and keep the data structured.
        const r = res && typeof res === "object" && "text" in res && typeof (res as McpResult).text === "string" ? (res as McpResult) : { text: JSON.stringify(res, null, 2), data: res };
        return reply(id, { content: [{ type: "text", text: r.text }], ...(r.data !== undefined ? { structuredContent: { result: r.data } } : {}) });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: (e as Error).message.split("\n")[0] }], isError: true });
      }
    }
    return fail(id, -32601, `method not found: ${method}`);
  });
}
