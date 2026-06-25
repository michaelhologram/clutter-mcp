/**
 * Tiny REST client for the Clutter API, used by the MCP server. Deliberately has NO dependency on
 * @clutter/core — the MCP server is a standalone process an AI agent runs locally, talking to the
 * deployed API over HTTPS with an API key. Configured from env:
 *   CLUTTER_API_URL  base URL including the /api prefix. Defaults to https://clutter.run/api
 *                    (the public deployment); override only to target another deployment.
 *   CLUTTER_API_KEY  a clt_live_… key minted in the web app (Settings) or POST /api-keys. Validated
 *                    lazily — the server boots and serves tools/list without it, so a client can
 *                    discover the tools before configuring; the key is required for any tool call.
 */
const DEFAULT_API_URL = "https://clutter.run/api";
export class ClutterClient {
  private readonly base: string;
  private readonly key: string | undefined;

  constructor(baseUrl: string, apiKey: string | undefined) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.key = apiKey;
  }

  static fromEnv(): ClutterClient {
    const base = process.env.CLUTTER_API_URL || DEFAULT_API_URL;
    return new ClutterClient(base, process.env.CLUTTER_API_KEY);
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.key) {
      throw new Error("CLUTTER_API_KEY is not set (mint one in the web app → Settings)");
    }
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const data: unknown = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const detail =
        data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : res.statusText;
      throw new ClutterApiError(res.status, detail, data);
    }
    return data;
  }

  get(path: string): Promise<unknown> {
    return this.request("GET", path);
  }
  post(path: string, body?: unknown): Promise<unknown> {
    return this.request("POST", path, body ?? {});
  }
  del(path: string): Promise<unknown> {
    return this.request("DELETE", path);
  }
}

export class ClutterApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown,
  ) {
    super(`HTTP ${status}: ${message}`);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
