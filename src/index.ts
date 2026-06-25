#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ClutterApiError, ClutterClient } from "./client.js";

/**
 * Clutter MCP server (Phase 6). A stdio MCP server that lets an AI agent drive the whole Clutter
 * pipeline — create a project, build a synthetic org, generate documents/data/metadata, poll for
 * completion, and fetch download URLs — by calling the public REST API with an API key.
 *
 * Run it from any MCP client (Claude Desktop/Code, etc.) with:
 *   CLUTTER_API_URL=https://<host>/api  CLUTTER_API_KEY=clt_live_…  clutter-mcp
 *
 * Each tool maps 1:1 to a REST endpoint and returns the raw JSON response as text. The async
 * contract is exposed both as raw poll tools (get_org/get_run) and as convenience waiters
 * (wait_for_org/wait_for_run) that block until a terminal state so an agent needn't hand-roll a loop.
 */

const client = ClutterClient.fromEnv();

const server = new McpServer({ name: "clutter", version: "1.0.0" });

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const fail = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/** Wrap a tool body so any API/network error becomes a clean isError result the agent can read. */
function tool(
  name: string,
  config: { title: string; description: string; inputSchema: z.ZodRawShape },
  run: (args: Record<string, unknown>) => Promise<unknown>,
): void {
  server.registerTool(name, config, async (args: Record<string, unknown>) => {
    try {
      return ok(await run(args));
    } catch (err) {
      if (err instanceof ClutterApiError) {
        return fail(`Clutter API error (${err.status}): ${err.message}`);
      }
      return fail(`Error: ${(err as Error).message}`);
    }
  });
}

const enc = encodeURIComponent;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- Identity + usage ----

tool("clutter_whoami", {
  title: "Who am I",
  description: "Return the authenticated Clutter user for the configured API key.",
  inputSchema: {},
}, () => client.get("/me"));

tool("get_usage", {
  title: "Get API usage",
  description: "Your Clutter API usage (request counts by route) over a rolling window + the daily quota.",
  inputSchema: { windowHours: z.number().int().min(1).max(720).optional() },
}, (a) => client.get(`/usage${a.windowHours ? `?windowHours=${a.windowHours}` : ""}`));

// ---- Projects ----

tool("list_projects", {
  title: "List projects",
  description: "List all of your Clutter projects (top-level tenant containers).",
  inputSchema: {},
}, () => client.get("/projects"));

tool("create_project", {
  title: "Create project",
  description: "Create a new Clutter project. Returns the project (with its id).",
  inputSchema: { name: z.string().min(1).max(200) },
}, (a) => client.post("/projects", { name: a.name }));

// ---- Organisations ----

tool("list_orgs", {
  title: "List organisations",
  description: "List the synthetic organisations in a project.",
  inputSchema: { projectId: z.string() },
}, (a) => client.get(`/orgs?projectId=${enc(String(a.projectId))}`));

tool("build_org", {
  title: "Build organisation (async)",
  description:
    "Start building a synthetic organisation from a prompt. Returns 202 with an orgId. The build " +
    "runs in the background (minutes) — then poll get_org, or call wait_for_org to block until ready. " +
    "Omit projectId to auto-create a project (named after the generated company) — the simplest path.",
  inputSchema: {
    prompt: z.string().min(1),
    projectId: z.string().optional().describe("Existing project to build into; OMIT to auto-create one"),
    projectName: z.string().max(200).optional().describe("Name for the auto-created project (optional)"),
    locale_language: z.string().optional().describe("BCP-47, e.g. en-US"),
    target_systems: z.array(z.string()).optional(),
    ref_org_id: z.string().optional().describe("Build a variant FROM an existing org"),
    web_search: z
      .boolean()
      .optional()
      .describe("Use web search for real-world grounding (default true; set false to disable)"),
  },
}, (a) =>
  client.post("/orgs", {
    prompt: a.prompt,
    projectId: a.projectId,
    projectName: a.projectName,
    locale_language: a.locale_language,
    target_systems: a.target_systems,
    ref_org_id: a.ref_org_id,
    web_search: a.web_search,
  }),
);

tool("get_org", {
  title: "Get organisation",
  description: "Get an organisation including its full org.json structure. Check `org.status`.",
  inputSchema: { orgId: z.string() },
}, (a) => client.get(`/orgs/${enc(String(a.orgId))}`));

tool("wait_for_org", {
  title: "Wait for organisation build",
  description:
    "Poll an org until its build reaches a terminal state (ready/failed) or the timeout. " +
    "Returns the final org summary.",
  inputSchema: {
    orgId: z.string(),
    timeoutSeconds: z.number().int().min(5).max(900).optional().describe("default 600"),
  },
}, async (a) => {
  const deadline = Date.now() + (Number(a.timeoutSeconds) || 600) * 1000;
  for (;;) {
    const res = (await client.get(`/orgs/${enc(String(a.orgId))}`)) as { org?: { status?: string } };
    const status = res?.org?.status;
    if (status === "ready" || status === "failed") return res;
    if (Date.now() >= deadline) return { timedOut: true, lastStatus: status, org: res?.org };
    await sleep(5000);
  }
});

tool("query_org", {
  title: "Query organisation",
  description: "Ask a grounded natural-language question about an organisation (synchronous answer).",
  inputSchema: {
    orgId: z.string(),
    message: z.string().min(1),
    locale_language: z.string().optional(),
  },
}, (a) =>
  client.post(`/orgs/${enc(String(a.orgId))}/query`, {
    message: a.message,
    locale_language: a.locale_language,
  }),
);

tool("delete_org", {
  title: "Delete organisation",
  description: "Delete an organisation and ALL its runs/artefacts (S3 + DB). Irreversible.",
  inputSchema: { orgId: z.string() },
}, (a) => client.del(`/orgs/${enc(String(a.orgId))}`));

// ---- Runs ----

tool("list_runs", {
  title: "List runs",
  description: "List the generation runs under an organisation.",
  inputSchema: { orgId: z.string() },
}, (a) => client.get(`/runs?orgId=${enc(String(a.orgId))}`));

tool("create_run", {
  title: "Create generation run (async)",
  description:
    "Launch a generation run. Returns 202 with a runId — poll get_run or call wait_for_run.\n" +
    "kind + params:\n" +
    "• doc_generator → { prompt, doc_number (≤300), file_types:[docx|pdf|xlsx|eml|jpg], " +
    "structure:'flat'|'nested', target_system?, allow_underscores? }\n" +
    "• data_generator → { prompt, row_count (≤2000), data_format:'xlsx'|'csv'|'json', data_fields?, target_system? }\n" +
    "• doc_metadata_gen → { sourceRunId (a completed doc_generator run), data_format, data_fields?, target_system? }",
  inputSchema: {
    orgId: z.string(),
    kind: z.enum(["doc_generator", "data_generator", "doc_metadata_gen"]),
    params: z.record(z.unknown()).optional(),
  },
}, (a) => client.post("/runs", { orgId: a.orgId, kind: a.kind, params: a.params ?? {} }));

tool("get_run", {
  title: "Get run status",
  description: "Get a run's status + progress counts. Poll this until status is terminal.",
  inputSchema: { runId: z.string() },
}, (a) => client.get(`/runs/${enc(String(a.runId))}`));

tool("wait_for_run", {
  title: "Wait for run",
  description:
    "Poll a run until it reaches a terminal state (complete/partial/failed) or the timeout. " +
    "Returns the final run status.",
  inputSchema: {
    runId: z.string(),
    timeoutSeconds: z.number().int().min(5).max(900).optional().describe("default 600"),
  },
}, async (a) => {
  const deadline = Date.now() + (Number(a.timeoutSeconds) || 600) * 1000;
  const terminal = new Set(["complete", "partial", "failed"]);
  for (;;) {
    const res = (await client.get(`/runs/${enc(String(a.runId))}`)) as { run?: { status?: string } };
    const status = res?.run?.status;
    if (status && terminal.has(status)) return res;
    if (Date.now() >= deadline) return { timedOut: true, lastStatus: status, run: res?.run };
    await sleep(5000);
  }
});

tool("list_run_documents", {
  title: "List run documents",
  description: "List the documents generated by a run (title, format, folderPath, status).",
  inputSchema: { runId: z.string() },
}, (a) => client.get(`/runs/${enc(String(a.runId))}/documents`));

tool("get_document_url", {
  title: "Get document download URL",
  description: "Get a short-lived presigned download URL for a single generated document.",
  inputSchema: { documentId: z.string() },
}, (a) => client.get(`/documents/${enc(String(a.documentId))}/url`));

tool("build_zip", {
  title: "Build run ZIP (async)",
  description: "Start building a single ZIP of all of a run's documents. Poll get_zip_url after.",
  inputSchema: { runId: z.string() },
}, (a) => client.post(`/runs/${enc(String(a.runId))}/zip`));

tool("get_zip_url", {
  title: "Get run ZIP URL",
  description: "Get a presigned download URL for a run's ZIP (409 until the build is ready).",
  inputSchema: { runId: z.string() },
}, (a) => client.get(`/runs/${enc(String(a.runId))}/zip/url`));

tool("delete_run", {
  title: "Delete run",
  description: "Delete a run and its artefacts (S3 + DB). Leaves the parent org intact. Irreversible.",
  inputSchema: { runId: z.string() },
}, (a) => client.del(`/runs/${enc(String(a.runId))}`));

// ---- Boot ----

const transport = new StdioServerTransport();
await server.connect(transport);
// Stay alive on stdio; log to stderr so stdout remains a clean MCP channel.
process.stderr.write("clutter-mcp: connected (stdio)\n");
