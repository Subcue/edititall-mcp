# EditItAll MCP Server

**[EditItAll](https://edititall.com)** is a free, local-first suite of in-browser editors (photo, vector, PDF, spreadsheet, Word, slides, image convert/compress) built by [Subcue AI LLC](https://subcueai.com). This repository is the **[Model Context Protocol](https://modelcontextprotocol.io) server** that lets Claude Code, Claude Desktop, Cursor, and any MCP client **operate those editors on your machine**.

Your files never leave the device. The server launches a local headless Chrome, loads the editors from [edititall.com](https://edititall.com) (or a local `wrangler dev` URL), and drives their official automation hooks. The AI client only sees tool results (cell values, file sizes, screenshots you request).

Public docs: **[https://edititall.com/ai](https://edititall.com/ai)**

## Requirements

- **Node.js 22+** (built-in `WebSocket`)
- **Chrome, Edge, Chromium, or Brave** installed locally

## Install

**Claude Desktop (one click).** Download [`edititall-mcp.mcpb`](https://edititall.com/edititall-mcp.mcpb) and drag it into Claude Desktop → Settings → Extensions. Claude Desktop ships its own Node runtime.

**Claude Code**

```sh
curl -fsSL https://edititall.com/edititall-mcp.mjs -o ~/edititall-mcp.mjs
claude mcp add edititall -- node ~/edititall-mcp.mjs
```

Or clone this repo:

```sh
git clone https://github.com/Subcue/edititall-mcp.git
claude mcp add edititall -- node /path/to/edititall-mcp/edititall-mcp.mjs
```

**Cursor / other stdio clients** (`mcp.json`):

```json
{
  "mcpServers": {
    "edititall": {
      "command": "node",
      "args": ["/path/to/edititall-mcp.mjs"]
    }
  }
}
```

Env:

| Variable | Default | Meaning |
|---|---|---|
| `EDITITALL_URL` | `https://edititall.com` | Editor origin (point at `wrangler dev` while developing) |
| `CHROME_PATH` | auto-detect Chrome/Edge/Chromium/Brave | Browser binary |

## Tools

| Tool | What it does |
|---|---|
| `sheet_set_cells` / `sheet_load_csv` / `sheet_export_csv` | Write cells/formulas, bulk-load CSV, export computed values |
| `sheet_read_range` | Read computed values of `"A1:D10"` as a 2D array |
| `pdf_open` / `pdf_page_text` / `pdf_rotate_page` / `pdf_delete_page` / `pdf_merge` / `pdf_export` | Open, read, reorganize and export PDFs locally |
| `word_write` / `word_get_text` | Draft and read documents |
| `slides_from_outline` | Build a deck from a title + bullet outline |
| `vector_import_svg` | Import SVG markup as a new vector document |
| `photo_open_image` / `photo_export` | Open a local image in the photo editor and export flattened |
| `images_process` | Compress/convert local images through the real codec pipeline; reports before/after sizes |
| `editor_screenshot` | Screenshot `sheet` \| `vector` \| `photo` \| `tools` \| `pdf` \| `word` \| `slides` |

Example prompts: *compress every PNG on the desktop to WebP at quality 80* · *build a Q3 budget sheet and total the column* · *draw a rocket in SVG and import it into the vector editor*.

## Privacy

The same promise as the website: **processing is on-device**. Headless Chrome talks to the editors in a local profile under `$TMPDIR`. Nothing is uploaded to Subcue AI LLC or to a third-party API by this server.

## Other machine-readable entry points

| Endpoint | What it is |
|---|---|
| [`https://edititall.com/ai`](https://edititall.com/ai) | Human + agent install docs |
| [`https://edititall.com/llms.txt`](https://edititall.com/llms.txt) | Plain-text product summary |
| [`https://edititall.com/edititall-mcp.mjs`](https://edititall.com/edititall-mcp.mjs) | Same server file, served from the product origin |
| [`https://edititall.com/edititall-mcp.mcpb`](https://edititall.com/edititall-mcp.mcpb) | Claude Desktop extension bundle |

The product suite itself is closed-source. This repository is the MCP client/server that talks to it.

## License

[MIT](LICENSE) © 2026 [Subcue AI LLC](https://subcueai.com). EditItAll is a brand of Subcue AI LLC.
