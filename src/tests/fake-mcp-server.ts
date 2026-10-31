/**
 * A tiny MCP server used only by Cephalo's tests (stdio or Streamable HTTP).
 * Tool definitions are read from the JSON file in FAKE_MCP_TOOLS on every request, so a test can change them
 * between scans to simulate a "rug pull".
 *
 *   node fake-mcp-server.js stdio
 *   node fake-mcp-server.js http          (prints "PORT <n>" on stdout once listening)
 *
 * Env: FAKE_MCP_TOOLS (file), FAKE_MCP_NEED_ENV ("NAME=value" must be in the environment),
 *      FAKE_MCP_PAGE=1 (one tool per page), FAKE_MCP_SSE=1 (answer HTTP with an event stream),
 *      FAKE_MCP_TOKEN (HTTP requires "Authorization: Bearer <token>"), FAKE_MCP_MARKER (file written on start).
 */
import fs from "node:fs";
import http from "node:http";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "stdio";
const toolsFile = process.env.FAKE_MCP_TOOLS ?? "";
const readTools = (): any[] => JSON.parse(fs.readFileSync(toolsFile, "utf8"));

if (process.env.FAKE_MCP_MARKER) fs.writeFileSync(process.env.FAKE_MCP_MARKER, "started\n");

function respond(m: any): any | null {
  if (m.id === undefined) return null; // notification
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
  if (m.method === "initialize") {
    const need = process.env.FAKE_MCP_NEED_ENV;
    if (need) {
      const [k, v] = need.split("=");
      if (process.env[k] !== v) return { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: `missing env ${k}` } };
    }
    return ok({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-notes", version: "1.0.0" } });
  }
  if (m.method === "tools/list") {
    const tools = readTools();
    if (process.env.FAKE_MCP_PAGE === "1") {
      const i = Number(m.params?.cursor ?? 0);
      return ok({ tools: tools.slice(i, i + 1), ...(i + 1 < tools.length ? { nextCursor: String(i + 1) } : {}) });
    }
    return ok({ tools });
  }
  if (m.method === "ping") return ok({});
  return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } };
}

if (mode === "http") {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const token = process.env.FAKE_MCP_TOKEN;
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized");
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const m = JSON.parse(body);
      if (m.method !== "initialize" && req.headers["mcp-session-id"] !== "s1") {
        res.writeHead(400).end("missing session");
        return;
      }
      const r = respond(m);
      if (r === null) {
        res.writeHead(202).end();
        return;
      }
      const headers: Record<string, string> = m.method === "initialize" ? { "mcp-session-id": "s1" } : {};
      if (process.env.FAKE_MCP_SSE === "1") {
        res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\nevent: message\ndata: ${JSON.stringify(r)}\n\n`);
      } else {
        res.writeHead(200, { ...headers, "content-type": "application/json" });
        res.end(JSON.stringify(r));
      }
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    console.log(`PORT ${typeof addr === "object" && addr ? addr.port : 0}`);
  });
} else {
  console.log("fake-notes server starting (this banner line is not JSON)");
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    try {
      const r = respond(JSON.parse(line));
      if (r) process.stdout.write(JSON.stringify(r) + "\n");
    } catch {
      /* ignore garbage */
    }
  });
}
