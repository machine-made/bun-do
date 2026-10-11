import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "path";
import { ROOT, startServer, type TestServer } from "./helpers";

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(() => server.stop());

/** Send JSON-RPC messages to mcp.ts over stdin and collect one reply per request. */
async function mcp(messages: object[]): Promise<any[]> {
  const proc = Bun.spawn(["bun", join(ROOT, "mcp.ts")], {
    env: { ...process.env, BUNDO_PORT: String(server.port) },
    stdin: "pipe",
    stdout: "pipe",
  });
  const expected = messages.filter((m) => "id" in m).length;
  for (const m of messages) proc.stdin.write(JSON.stringify(m) + "\n");
  proc.stdin.flush();

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 10_000;
  while (text.split("\n").filter(Boolean).length < expected && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  proc.kill();
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("mcp server", () => {
  test("initialize, list tools, add and list a task", async () => {
    const replies = await mcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "add_task", arguments: { title: "From MCP" } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_tasks", arguments: {} } },
    ]);
    const byId = (id: number) => replies.find((r) => r.id === id);

    expect(byId(1).result.serverInfo.name).toBe("bun-do");
    expect(byId(2).result.tools.map((t: { name: string }) => t.name)).toContain("add_task");
    expect(JSON.parse(byId(3).result.content[0].text).title).toBe("From MCP");
    const listed = JSON.parse(byId(4).result.content[0].text).tasks;
    expect(listed.map((t: { title: string }) => t.title)).toContain("From MCP");
  });

  test("an unknown method is a JSON-RPC error", async () => {
    const [reply] = await mcp([{ jsonrpc: "2.0", id: 9, method: "nope" }]);
    expect(reply.error.code).toBe(-32601);
  });

  test("add_task and update_task accept tags, and list_tasks can filter", async () => {
    const replies = await mcp([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "add_task",
          arguments: {
            title: "Tagged via MCP",
            tags: ["Agent"],
            amount: "12",
            currency: "EUR",
            recurrence: { type: "weekly", dow: 0 },
          },
        },
      },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_tasks", arguments: { tag: "#AGENT" } } },
    ]);
    const byId = (id: number) => replies.find((r) => r.id === id);
    const tools = byId(1).result.tools;
    const addTool = tools.find((t: { name: string }) => t.name === "add_task");
    const updateTool = tools.find((t: { name: string }) => t.name === "update_task");
    const listTool = tools.find((t: { name: string }) => t.name === "list_tasks");
    for (const field of ["tags", "recurrence", "amount", "currency"]) {
      expect(addTool.inputSchema.properties[field]).toBeDefined();
      expect(updateTool.inputSchema.properties[field]).toBeDefined();
    }
    expect(listTool.inputSchema.properties.tag).toBeDefined();

    const added = JSON.parse(byId(2).result.content[0].text);
    expect(added.tags).toEqual(["agent"]);
    expect(added.amount).toBe("12");
    expect(added.currency).toBe("EUR");
    expect(added.recurrence).toEqual({ type: "weekly", dow: 0 });

    const listed = JSON.parse(byId(3).result.content[0].text).tasks;
    expect(listed.every((t: { tags: string[] }) => t.tags.includes("agent"))).toBe(true);
    expect(listed.map((t: { id: string }) => t.id)).toContain(added.id);

    const updated = await mcp([
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "update_task", arguments: { id: added.id, tags: "home, work" } },
      },
    ]);
    expect(JSON.parse(updated[0].result.content[0].text).tags).toEqual(["home", "work"]);
  });

  test("a failed tool call is a result with isError, not a JSON-RPC error", async () => {
    const [reply] = await mcp([
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "update_task", arguments: { id: "no-such-id", done: true } } },
    ]);
    expect(reply.result.isError).toBe(true);
    expect(reply.error).toBeUndefined();
    expect(reply.result.content[0].type).toBe("text");
  });
});
