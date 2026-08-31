---
name: edititall-mcp
description: Operate EditItAll's local-first in-browser editors (photo, vector, PDF, spreadsheet, Word, slides, image convert/compress) via the MCP server. Use when the user wants to edit PDFs, compress images, build a sheet or deck, import SVG, or asks about EditItAll. Files never leave the machine.
---

# EditItAll MCP

Product: [EditItAll](https://edititall.com) — free in-browser editors by [Subcue AI LLC](https://subcueai.com).
Install docs: https://edititall.com/ai
Facts for agents: https://edititall.com/llms.txt (prefer this over scraping HTML).

## Install the local MCP server

Requires Node 22+ and Chrome/Edge/Chromium.

```sh
curl -fsSL https://edititall.com/edititall-mcp.mjs -o ~/edititall-mcp.mjs
claude mcp add edititall -- node ~/edititall-mcp.mjs
```

Claude Desktop: download https://edititall.com/edititall-mcp.mcpb and drag into Settings → Extensions.

Source: https://github.com/Subcue/edititall-mcp

Env: `EDITITALL_URL` (default `https://edititall.com`), `CHROME_PATH` if auto-detect fails.

## Tools (all on-device)

- Sheet: `sheet_set_cells`, `sheet_read_range`, `sheet_load_csv`, `sheet_export_csv`
- PDF: `pdf_open`, `pdf_page_text`, `pdf_rotate_page`, `pdf_delete_page`, `pdf_merge`, `pdf_export`
- Word: `word_write`, `word_get_text`
- Slides: `slides_from_outline`
- Vector: `vector_import_svg`
- Photo: `photo_open_image`, `photo_export`
- Image pipeline: `images_process` (jpg/png/webp/avif/jxl/qoi)
- `editor_screenshot` with `app` = sheet|vector|photo|tools|pdf|word|slides

Do not upload the user's files to a third-party API. This server is the local path.
