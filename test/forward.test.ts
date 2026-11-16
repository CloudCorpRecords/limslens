import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  LimslensClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real Limslane endpoint is
 * never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/limslane-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 25 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}

/** Recursively strip `description` fields (tool- and parameter-level).
 * Ruling 1 (extended fleet-wide 2026-11-15): the served tools carry
 * parameter descriptions added over the original capture; everything
 * else must match the fixture exactly. */
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k !== "description") out[k] = stripDescriptions(v);
    }
    return out;
  }
  return value;
}


const COLUMNS = "dataset_columns";
const SEARCH = "dataset_search";
const ROW = "dataset_row";
const COMPARE = "dataset_compare";
const STATS = "dataset_stats";
const TOP = "dataset_top";
const PROVENANCE = "dataset_provenance";
const ALL_TOOLS = [COLUMNS, SEARCH, ROW, COMPARE, STATS, TOP, PROVENANCE];

const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"rows\":[{\"name\":\"alpha\"}]}" }],
  structuredContent: { rows: [{ name: "alpha" }] },
};

const SAMPLE_ARGS = { query: "alpha" };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-abc" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "limslane", version: "1.0.1" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new LimslensClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

function toolByName(name: string): ToolDef {
  const tool = TOOL_DEFS.find((t) => t.name === name);
  assert.ok(tool !== undefined, `tool ${name} missing`);
  return tool;
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 7 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 7);
    assert.deepEqual(stripDescriptions(TOOL_DEFS), stripDescriptions(fixture.tools));
  });

  it("serves the 7 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
  });

  it("carries exactly the fixture's keys on every tool", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("carries the fixture's titles verbatim", () => {
    assert.equal(toolByName(COLUMNS).title, "Dataset columns and shape");
    assert.equal(toolByName(SEARCH).title, "Search the dataset");
    assert.equal(toolByName(ROW).title, "Look a row up by an exact key");
    assert.equal(toolByName(COMPARE).title, "Compare rows side by side");
    assert.equal(toolByName(STATS).title, "Summary statistics for a numeric column");
    assert.equal(toolByName(TOP).title, "Rank rows by a numeric column");
    assert.equal(
      toolByName(PROVENANCE).title,
      "Where this data comes from, and how to cite it",
    );
  });

  it("carries the fixture's descriptions verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].description, fixture.tools[i].description);
    }
    assert.match(toolByName(COLUMNS).description, /Call this first to learn the schema/);
    assert.match(toolByName(STATS).description, /non-numeric rows are excluded and counted/);
    assert.match(toolByName(PROVENANCE).description, /attribute a figure correctly/);
  });

  it("dataset_columns and dataset_provenance carry no required key", () => {
    assert.equal("required" in schemaOf(toolByName(COLUMNS)), false);
    assert.equal("required" in schemaOf(toolByName(PROVENANCE)), false);
  });

  it("carries the fixture's required fields on the other five tools", () => {
    assert.deepEqual(schemaOf(toolByName(SEARCH)).required, ["query"]);
    assert.deepEqual(schemaOf(toolByName(ROW)).required, ["column", "value"]);
    assert.deepEqual(schemaOf(toolByName(COMPARE)).required, ["column", "values"]);
    assert.deepEqual(schemaOf(toolByName(STATS)).required, ["column"]);
    assert.deepEqual(schemaOf(toolByName(TOP)).required, ["column"]);
  });

  it("carries the $schema marker and object type on every inputSchema", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal(schemaOf(tool).type, "object");
      assert.equal(
        schemaOf(tool)["$schema"],
        "http://json-schema.org/draft-07/schema#",
      );
    }
  });

  it("sets additionalProperties false on the five argument tools only", () => {
    for (const name of [SEARCH, ROW, COMPARE, STATS, TOP]) {
      assert.equal(schemaOf(toolByName(name)).additionalProperties, false);
    }
    assert.equal("additionalProperties" in schemaOf(toolByName(COLUMNS)), false);
    assert.equal("additionalProperties" in schemaOf(toolByName(PROVENANCE)), false);
  });

  it("carries every fixture property, in order, for every tool", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      const served = Object.keys(schemaOf(TOOL_DEFS[i]).properties);
      const expected = Object.keys(schemaOf(fixture.tools[i]).properties);
      assert.deepEqual(served, expected);
    }
  });

  it("carries the exact property sets per tool", () => {
    assert.deepEqual(Object.keys(schemaOf(toolByName(COLUMNS)).properties), []);
    assert.deepEqual(Object.keys(schemaOf(toolByName(SEARCH)).properties), [
      "query",
      "limit",
    ]);
    assert.deepEqual(Object.keys(schemaOf(toolByName(ROW)).properties), [
      "column",
      "value",
    ]);
    assert.deepEqual(Object.keys(schemaOf(toolByName(COMPARE)).properties), [
      "column",
      "values",
    ]);
    assert.deepEqual(Object.keys(schemaOf(toolByName(STATS)).properties), [
      "column",
    ]);
    assert.deepEqual(Object.keys(schemaOf(toolByName(TOP)).properties), [
      "column",
      "limit",
      "ascending",
    ]);
    assert.deepEqual(Object.keys(schemaOf(toolByName(PROVENANCE)).properties), []);
  });

  it("dataset_search query is a non-empty string described as text to look for in any cell", () => {
    const query = schemaOf(toolByName(SEARCH)).properties.query;
    assert.equal(query.type, "string");
    assert.equal(query.minLength, 1);
    assert.equal(query.description, "text to look for in any cell");
  });

  it("limit is a 1..50 integer on dataset_search and dataset_top", () => {
    for (const name of [SEARCH, TOP]) {
      const limit = schemaOf(toolByName(name)).properties.limit;
      assert.equal(limit.type, "integer");
      assert.equal(limit.minimum, 1);
      assert.equal(limit.maximum, 50);
    }
  });

  it("column and value are non-empty strings wherever they appear", () => {
    for (const name of [ROW, COMPARE, STATS, TOP]) {
      const column = schemaOf(toolByName(name)).properties.column;
      assert.equal(column.type, "string");
      assert.equal(column.minLength, 1);
    }
    const value = schemaOf(toolByName(ROW)).properties.value;
    assert.equal(value.type, "string");
    assert.equal(value.minLength, 1);
  });

  it("dataset_compare values is an array of 2..10 non-empty strings", () => {
    const values = schemaOf(toolByName(COMPARE)).properties.values;
    assert.equal(values.type, "array");
    assert.equal(values.minItems, 2);
    assert.equal(values.maxItems, 10);
    assert.equal(values.items.type, "string");
    assert.equal(values.items.minLength, 1);
  });

  it("dataset_top ascending is a boolean defaulting to highest first", () => {
    const ascending = schemaOf(toolByName(TOP)).properties.ascending;
    assert.equal(ascending.type, "boolean");
    assert.equal(
      ascending.description,
      "true for the lowest first; default highest first",
    );
  });

  it("isKnownTool recognises the captured tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("dataset"), false);
    assert.equal(isKnownTool("dataset_searches"), false);
    assert.equal(isKnownTool(""), false);
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://limslane.com/mcp");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-abc");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-abc");
  });

  it("sends clientInfo name limslens and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH, SAMPLE_ARGS);
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "limslens", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH, SAMPLE_ARGS);
    await c.callTool(STATS, { column: "score" });
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-abc");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the LIMSLANE_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new LimslensClient({
      fetchFn: upstream.fetchFn,
      env: { LIMSLANE_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { LIMSLANE_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new LimslensClient({
      fetchFn: upstream.fetchFn,
      env: { LIMSLANE_MCP_URL: "   " },
    });
    await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("no auth header is ever sent (record declares NO headers)", () => {
  it("sends no Authorization header when the environment is empty", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header even when a LIMSLANE_API_KEY-style env var is present", async () => {
    const upstream = makeUpstream();
    const c = new LimslensClient({
      fetchFn: upstream.fetchFn,
      env: { LIMSLANE_API_KEY: "some-key-42" },
    });
    await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("sends no Authorization header even when AUTHORIZATION / API_KEY env vars are present", async () => {
    const upstream = makeUpstream();
    const c = new LimslensClient({
      fetchFn: upstream.fetchFn,
      env: { AUTHORIZATION: "Bearer x", API_KEY: "y", LIMSLANE_TOKEN: "z" },
    });
    await c.callTool(ROW, { column: "name", value: "alpha" });
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("never sends an X-API-Key header either", async () => {
    const upstream = makeUpstream();
    const c = new LimslensClient({
      fetchFn: upstream.fetchFn,
      env: { LIMSLANE_API_KEY: "some-key-42" },
    });
    await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.headers["X-API-Key"] === undefined));
  });

  it("sends only Content-Type, Accept and (when issued) Mcp-Session-Id headers", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.deepEqual(Object.keys(calls[0].headers).sort(), [
      "Accept",
      "Content-Type",
    ]);
    assert.deepEqual(Object.keys(calls[2].headers).sort(), [
      "Accept",
      "Content-Type",
      "Mcp-Session-Id",
    ]);
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a dataset_search call verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH, SAMPLE_ARGS);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, SEARCH);
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards a dataset_compare call with every option verbatim", async () => {
    const args = { column: "name", values: ["alpha", "beta", "gamma"] };
    const { client: c, calls } = stubClient();
    await c.callTool(COMPARE, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, COMPARE);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards dataset_top under its own name", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(TOP, { column: "score", limit: 5, ascending: true });
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, TOP);
    assert.deepEqual(params.arguments, {
      column: "score",
      limit: 5,
      ascending: true,
    });
  });

  it("forwards a no-argument dataset_columns call with empty arguments", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(COLUMNS, {});
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, COLUMNS);
    assert.deepEqual(params.arguments, {});
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "no such column upstream" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(STATS, { column: "nope" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      PROVENANCE,
      {},
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, PROVENANCE);
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as limslens error text", () => {
  it("maps a JSON-RPC error to `limslens error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "lookup failed upstream" },
    });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "limslens error: lookup failed upstream");
  });

  it("maps an initialize JSON-RPC error to limslens error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "limslens error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "limslens error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "limslens error: malformed response");
  });

  it("maps a non-2xx upstream status to limslens error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "limslens error: HTTP 500");
  });

  it("maps a throwing fetch to limslens error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^limslens error: /);
  });

  it("maps a throwing initialize fetch to limslens error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "limslens error: socket hang up");
  });

  it("maps a timed-out call to limslens error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^limslens error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, SEARCH, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, SEARCH, "query=alpha"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid dataset_search call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, SEARCH, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards a valid dataset_row call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, ROW, { column: "name", value: "alpha" });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, ROW);
    assert.deepEqual(params.arguments, { column: "name", value: "alpha" });
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, COLUMNS, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("no command at all prints usage on stderr and exits 2", () => {
    const res = runCli([]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([SEARCH, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([SEARCH, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after a tool exit 2", () => {
    const res = runCli([SEARCH, "{}", "extra"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
