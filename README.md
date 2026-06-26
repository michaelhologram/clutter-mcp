# clutter-mcp — synthetic data & synthetic document generator (MCP server)

A [Model Context Protocol](https://modelcontextprotocol.io) **stdio** server that lets an AI agent
drive the whole [Clutter](https://clutter.run) pipeline — invent a believable synthetic company,
mass-produce the documents, spreadsheets, emails, images and datasets it would really have, poll for
completion, and fetch download URLs — through Clutter's public REST API, authenticated with an API key.

Use it to fill dev/test/demo systems (SharePoint, CRMs, file shares) with realistic content —
**synthetic documents and synthetic data** that stand in for the real thing. Generate **test data,
demo data and training data**, or **test documents and training documents**, on demand — or give an
AI agent believable data to reason over, all without touching real or sensitive data.

It's a thin HTTPS client with **no dependency on the rest of the Clutter codebase**.

## Quick start

1. Create a free account at **https://clutter.run**, open **Settings**, and mint an API key
   (`clt_live_…`, shown once).
2. Add the server to your MCP client config (Claude Code, Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "clutter": {
      "command": "npx",
      "args": ["-y", "clutter-mcp"],
      "env": {
        "CLUTTER_API_KEY": "clt_live_…"
      }
    }
  }
}
```

That's it — `CLUTTER_API_URL` defaults to `https://clutter.run/api`, so only the key is required.

## Configuration

| Env var           | Required | Default                   | Notes                                          |
| ----------------- | -------- | ------------------------- | ---------------------------------------------- |
| `CLUTTER_API_KEY` | yes      | —                         | `clt_live_…` key (web app → **Settings**)      |
| `CLUTTER_API_URL` | no       | `https://clutter.run/api` | Override only to target another deployment      |

## Run directly

```bash
CLUTTER_API_KEY=clt_live_… npx -y clutter-mcp
```

## Typical agent flow

1. `build_org` — describe a company in a sentence → returns an `orgId` (omit `projectId` to
   auto-create a project). Free.
2. `wait_for_org` — block until the company build is `ready`.
3. `create_run` — generate content against the company:
   - `doc_generator` → a batch of documents (`docx`/`pdf`/`xlsx`/`eml`/`jpg`), folder-organised.
   - `data_generator` → one tabular dataset (`xlsx`/`csv`/`json`) with an exact row count.
   - `doc_metadata_gen` → one metadata record per document of a prior doc run.
4. `wait_for_run` — block until the run is `complete`.
5. `list_run_documents` + `get_document_url`, or `build_zip` + `get_zip_url` for the whole run as a
   single ZIP (folder tree preserved — ready to drop into SharePoint or a file share).

## Tools

- **Identity / usage:** `clutter_whoami`, `get_usage`
- **Projects:** `list_projects`, `create_project`
- **Companies:** `list_orgs`, `build_org`, `get_org`, `wait_for_org`, `query_org`, `delete_org`
- **Runs:** `list_runs`, `create_run`, `get_run`, `wait_for_run`, `list_run_documents`,
  `get_document_url`, `build_zip`, `get_zip_url`, `delete_run`

`build_org` and `create_run` are asynchronous (return an id immediately); use the `wait_for_*` tools
to block until a terminal state, or poll `get_org` / `get_run`. Each tool maps to a REST endpoint and
returns the raw JSON response.

## Billing

Company builds, metadata and "ask the company" are free. New accounts get 10 free documents + 100
free data rows, then pay-as-you-go (all prices USD: $0.10/document, $0.06/10 data rows). A `402` from `create_run`
means insufficient credit — top up at https://clutter.run/billing.

## Loading content into SharePoint

Clutter hands you download URLs; your agent does the upload (via Microsoft Graph). Beyond a
plain "drop files into a library", the generated metadata can drive automation — apply
sensitivity labels, set permissions, assign retention, route flat files to the right
site/library by metadata, or even generate the information architecture itself. Worked
patterns with Graph calls: **https://clutter.run/sharepoint-cookbook.md**

## Reference

Full REST API: **https://clutter.run/api/docs** (Swagger UI) · machine-readable guide:
**https://clutter.run/llms.txt**

## License

MIT
