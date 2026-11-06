import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const sessionId = process.argv[2] ?? process.env.OPENCODE_E2E_SESSION;
if (!sessionId) {
  console.error("usage: bun mcp-probe.mjs <session_id> (or set OPENCODE_E2E_SESSION)");
  process.exit(1);
}

const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:31701/mcp"));
const client = new Client({ name: "probe", version: "0.0.1" });

await client.connect(transport);
console.log("CONNECTED");

const tools = await client.listTools();
console.log("TOOLS=" + JSON.stringify(tools.tools.map((t) => t.name)));

const list = await client.callTool({ name: "list_sessions", arguments: { limit: 3 } });
const listText = list.content.map((c) => c.text ?? "").join("");
console.log("LIST_SESSIONS_LEN=" + listText.length);
console.log("LIST_SESSIONS_HEAD=" + JSON.stringify(listText.slice(0, 160)));

const read = await client.callTool({ name: "read_session", arguments: { session_id: sessionId } });
const readText = read.content.map((c) => c.text ?? "").join("");
console.log("READ_SESSION_ID=" + sessionId);
console.log("READ_SESSION_LEN=" + readText.length);
console.log("READ_SESSION_STARTS_HASH=" + readText.startsWith("# "));
console.log("READ_SESSION_HEAD=" + JSON.stringify(readText.slice(0, 120)));

await client.close();
console.log("DONE");
