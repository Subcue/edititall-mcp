#!/usr/bin/env node
// EditItAll MCP server — lets an AI client (Claude Code / Claude Desktop / any
// MCP client) operate the EditItAll suite: write & read spreadsheet cells,
// import AI-generated SVG into the vector editor, open/export photos, and run
// images through the real compress/convert pipeline.
//
// Privacy model: everything runs ON THIS MACHINE. The server launches a local
// headless Chrome, loads the (local-first) editors, and drives their official
// automation hooks (window.__sub*). Files never leave the device — the same
// promise the site itself makes.
//
// Zero dependencies (Node >= 22 for the built-in WebSocket). MCP stdio
// transport: newline-delimited JSON-RPC 2.0.
//
// Env:
//   EDITITALL_URL  base URL (default https://edititall.com; use a local
//                  wrangler dev URL when developing)
//   CHROME_PATH    Chrome/Chromium binary (default: macOS Google Chrome)

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

const BASE = process.env.EDITITALL_URL || 'https://edititall.com';

/** Locate a Chromium-family browser without any user configuration. */
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        ]
      : process.platform === 'win32'
        ? [
            (process.env['PROGRAMFILES'] || 'C:\\Program Files') + '\\Google\\Chrome\\Application\\chrome.exe',
            (process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)') + '\\Google\\Chrome\\Application\\chrome.exe',
            (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
            (process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)') + '\\Microsoft\\Edge\\Application\\msedge.exe',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
            '/usr/bin/microsoft-edge',
          ];
  return candidates.find((p) => p && existsSync(p)) || candidates[0];
}
const CHROME = findChrome();
const CDP_PORT = 9331;
const PROFILE = join(tmpdir(), `edititall-mcp-${process.pid}`);
const log = (...a) => console.error('[edititall-mcp]', ...a);

// ---------------------------------------------------------------- CDP driver

let chrome = null;
const tabs = new Map(); // appId -> { send, evalJs }

async function ensureChrome() {
  if (chrome) return;
  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
    '--window-size=1600,1000', '--hide-scrollbars', '--enable-unsafe-swiftshader',
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });
  chrome.on('exit', () => { chrome = null; tabs.clear(); });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Chrome did not start (CHROME_PATH=${CHROME})`);
}

const APPS = {
  sheet: { url: '/sheet-editor/app', boot: '!!(window.__subsheet && window.__subsheet.set)' },
  vector: { url: '/vector-editor/app', boot: '!!(window.__subai && window.__subai.openSVGText)' },
  photo: { url: '/photo-editor/app', boot: '!!(window.__subps && window.__subps.openImageFromURL)' },
  tools: { url: '/tools', boot: '!!(window.__subtools && window.__subtools.addBytes)' },
  pdf: { url: '/pdf-editor/app', boot: '!!(window.__subpdf && window.__subpdf.openBytesAsFile)' },
  word: { url: '/word-editor/app', boot: '!!(window.__subword && window.__subword.type)' },
  slides: { url: '/slides-editor/app', boot: '!!(window.__subslides && window.__subslides.addShape)' },
};

async function tab(appId) {
  if (tabs.has(appId)) return tabs.get(appId);
  await ensureChrome();
  const spec = APPS[appId];
  const t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(BASE + spec.url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('CDP socket failed'))); });
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  });
  ws.addEventListener('close', () => tabs.delete(appId));
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'unknown').slice(0, 400));
    return r.result?.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  // wait for the app's automation hook
  const t0 = Date.now();
  for (;;) {
    if (await evalJs(spec.boot).catch(() => false)) break;
    if (Date.now() - t0 > 60000) throw new Error(`${appId} did not boot within 60s at ${BASE}${spec.url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  const handle = { send, evalJs };
  tabs.set(appId, handle);
  return handle;
}

// ---------------------------------------------------------------- helpers

/** "B3" -> {r:2, c:1} (0-based). */
function parseA1(ref) {
  const m = /^([A-Za-z]+)([0-9]+)$/.exec(ref.trim());
  if (!m) throw new Error(`bad cell reference "${ref}" — use A1 notation`);
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: parseInt(m[2], 10) - 1, c: c - 1 };
}
function parseRange(range) {
  const [a, b] = range.split(':');
  const p = parseA1(a); const q = b ? parseA1(b) : p;
  return { r1: Math.min(p.r, q.r), c1: Math.min(p.c, q.c), r2: Math.max(p.r, q.r), c2: Math.max(p.c, q.c) };
}
const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });
const err = (s) => ({ content: [{ type: 'text', text: String(s) }], isError: true });

// ---------------------------------------------------------------- tools

const TOOLS = [
  {
    name: 'sheet_set_cells',
    description: 'Write values or formulas (strings starting with "=") into the EditItAll spreadsheet. Cells use A1 notation. The sheet recalculates instantly.',
    inputSchema: { type: 'object', properties: { cells: { type: 'object', description: 'Map of A1 reference to raw value, e.g. {"A1":"Item","B2":"=SUM(B3:B9)"}', additionalProperties: { type: 'string' } } }, required: ['cells'] },
    async run({ cells }) {
      const t = await tab('sheet');
      const entries = Object.entries(cells).map(([ref, v]) => ({ ...parseA1(ref), v: String(v) }));
      await t.evalJs(`(() => { const s = window.__subsheet; for (const e of ${JSON.stringify(entries)}) s.set(e.r, e.c, e.v); return true; })()`);
      return text(`wrote ${entries.length} cell(s)`);
    },
  },
  {
    name: 'sheet_read_range',
    description: 'Read COMPUTED display values from the spreadsheet as a 2D array. Range in A1 notation, e.g. "A1:D10" or a single cell "B2".',
    inputSchema: { type: 'object', properties: { range: { type: 'string' } }, required: ['range'] },
    async run({ range }) {
      const t = await tab('sheet');
      const { r1, c1, r2, c2 } = parseRange(range);
      const rows = await t.evalJs(`(() => { const s = window.__subsheet, out = []; for (let r = ${r1}; r <= ${r2}; r++) { const row = []; for (let c = ${c1}; c <= ${c2}; c++) row.push(s.display(r, c)); out.push(row); } return out; })()`);
      return text(rows);
    },
  },
  {
    name: 'sheet_load_csv',
    description: 'Replace the spreadsheet with CSV content (bulk load — much faster than cell-by-cell). Provide inline `csv` text or a local file `path`. Formulas in cells (starting "=") are evaluated.',
    inputSchema: { type: 'object', properties: { csv: { type: 'string' }, path: { type: 'string' } } },
    async run({ csv, path }) {
      const textCsv = csv ?? readFileSync(resolve(path), 'utf8');
      const t = await tab('sheet');
      await t.evalJs(`window.__subsheet.loadCSV(${JSON.stringify(textCsv)})`);
      const lines = textCsv.trim().split(/\r?\n/).length;
      return text(`loaded ${lines} row(s) of CSV into the spreadsheet`);
    },
  },
  {
    name: 'sheet_export_csv',
    description: 'Export the spreadsheet\'s COMPUTED values as CSV — returned inline, and written to `path` if given.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    async run({ path }) {
      const t = await tab('sheet');
      const csv = await t.evalJs('window.__subsheet.toCSV()');
      if (path) {
        mkdirSync(dirname(resolve(path)), { recursive: true });
        writeFileSync(resolve(path), csv);
        return text(`wrote ${csv.length} bytes of CSV to ${resolve(path)}`);
      }
      return text(csv.length > 20000 ? csv.slice(0, 20000) + '\n…(truncated)' : csv);
    },
  },
  {
    name: 'pdf_open',
    description: 'Open a local PDF in the EditItAll PDF editor. Returns the page count. (Best for files up to ~20 MB.)',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async run({ path }) {
      const bytes = readFileSync(resolve(path));
      const t = await tab('pdf');
      const n = await t.evalJs(`(async () => {
        const bin = atob(${JSON.stringify(bytes.toString('base64'))});
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        await window.__subpdf.openBytesAsFile(u, ${JSON.stringify(basename(path))});
        return window.__subpdf.pageCount();
      })()`, true);
      return text(`opened ${basename(path)} — ${n} page(s)`);
    },
  },
  {
    name: 'pdf_export',
    description: 'Export the PDF editor\'s current document (with all edits) to a local file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async run({ path }) {
      const t = await tab('pdf');
      const b64 = await t.evalJs(`(async () => {
        const b = await window.__subpdf.exportBytes();
        if (!b) return null;
        let s = '';
        for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
        return btoa(s);
      })()`, true);
      if (!b64) return err('no document open in the PDF editor');
      mkdirSync(dirname(resolve(path)), { recursive: true });
      writeFileSync(resolve(path), Buffer.from(b64, 'base64'));
      return text(`exported PDF to ${resolve(path)} (${Buffer.from(b64, 'base64').length} bytes)`);
    },
  },
  {
    name: 'pdf_rotate_page',
    description: 'Rotate one page of the open PDF. page is 1-based; degrees is 90, -90 or 180.',
    inputSchema: { type: 'object', properties: { page: { type: 'number' }, degrees: { type: 'number', default: 90 } }, required: ['page'] },
    async run({ page, degrees = 90 }) {
      const t = await tab('pdf');
      await t.evalJs(`window.__subpdf.rotatePage(${page}, ${degrees})`, true);
      return text(`rotated page ${page} by ${degrees}°`);
    },
  },
  {
    name: 'pdf_delete_page',
    description: 'Delete one page (1-based) of the open PDF. Returns the new page count.',
    inputSchema: { type: 'object', properties: { page: { type: 'number' } }, required: ['page'] },
    async run({ page }) {
      const t = await tab('pdf');
      const n = await t.evalJs(`window.__subpdf.deletePage(${page})`, true);
      return text(`deleted page ${page} — ${n} page(s) remain`);
    },
  },
  {
    name: 'pdf_merge',
    description: 'Append the pages of another local PDF into the open document (after page `after`, default: at the end). Returns the new page count.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, after: { type: 'number' } }, required: ['path'] },
    async run({ path, after }) {
      const bytes = readFileSync(resolve(path));
      const t = await tab('pdf');
      const n = await t.evalJs(`(async () => {
        const bin = atob(${JSON.stringify(bytes.toString('base64'))});
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        return window.__subpdf.mergeBytes(u${after ? `, ${after}` : ''});
      })()`, true);
      return text(`merged ${basename(path)} — document now has ${n} page(s)`);
    },
  },
  {
    name: 'pdf_page_text',
    description: 'Extract the text of one page (1-based) of the open PDF — lets you READ a PDF without uploading it anywhere.',
    inputSchema: { type: 'object', properties: { page: { type: 'number' } }, required: ['page'] },
    async run({ page }) {
      const t = await tab('pdf');
      const s = await t.evalJs(`window.__subpdf.pageText(${page})`, true);
      return text(s || '(no extractable text on this page)');
    },
  },
  {
    name: 'word_write',
    description: 'Type text into the EditItAll document editor at the caret (use \\n for new paragraphs).',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async run({ text: s }) {
      const t = await tab('word');
      await t.evalJs(`window.__subword.type(${JSON.stringify(s)})`);
      return text(`typed ${s.length} character(s)`);
    },
  },
  {
    name: 'word_get_text',
    description: 'Read the document editor\'s current content as plain text.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const t = await tab('word');
      const s = await t.evalJs('window.__subword.text()');
      return text(s || '(empty document)');
    },
  },
  {
    name: 'slides_from_outline',
    description: 'Build a whole presentation in the EditItAll slides editor from an outline: a title slide plus one slide per entry (title + bullet list). Replaces the current deck.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        subtitle: { type: 'string' },
        slides: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } } }, required: ['title'] } },
      },
      required: ['title'],
    },
    async run(outline) {
      const t = await tab('slides');
      const n = await t.evalJs(`window.__subslides.fromOutline(${JSON.stringify(outline)})`);
      return text(`built a ${n}-slide presentation — use editor_screenshot {"app":"slides"} to see it`);
    },
  },
  {
    name: 'vector_import_svg',
    description: 'Import SVG markup into the EditItAll vector editor as a new document (the natural way for an AI to draw: generate SVG, then refine in the editor).',
    inputSchema: { type: 'object', properties: { svg: { type: 'string' }, name: { type: 'string', default: 'ai-drawing.svg' } }, required: ['svg'] },
    async run({ svg, name = 'ai-drawing.svg' }) {
      const t = await tab('vector');
      const ok = await t.evalJs(`window.__subai.openSVGText(${JSON.stringify(svg)}, ${JSON.stringify(name)})`);
      return ok ? text(`imported "${name}" into the vector editor`) : err('SVG import failed (invalid SVG?)');
    },
  },
  {
    name: 'photo_open_image',
    description: 'Open a local image file (png/jpg/webp) in the EditItAll photo editor as a new document.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'absolute path to the image' } }, required: ['path'] },
    async run({ path }) {
      const bytes = readFileSync(resolve(path));
      const ext = path.toLowerCase().split('.').pop();
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
      const t = await tab('photo');
      await t.evalJs(`window.__subps.openImageFromURL("data:${mime};base64,${bytes.toString('base64')}", ${JSON.stringify(basename(path))})`, true);
      return text(`opened ${basename(path)} (${bytes.length} bytes) in the photo editor`);
    },
  },
  {
    name: 'photo_export',
    description: 'Export the photo editor\'s current document (flattened) to a local file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'output file path (.png or .jpg)' }, quality: { type: 'number', default: 0.92 } }, required: ['path'] },
    async run({ path, quality = 0.92 }) {
      const t = await tab('photo');
      const type = /\.jpe?g$/i.test(path) ? 'jpeg' : 'png';
      const dataURL = await t.evalJs(`window.__subps.exportDataURL(${JSON.stringify(type)}, ${quality})`, true);
      if (!dataURL) return err('no document open in the photo editor');
      const b64 = dataURL.split(',')[1];
      mkdirSync(dirname(resolve(path)), { recursive: true });
      writeFileSync(resolve(path), Buffer.from(b64, 'base64'));
      return text(`exported to ${resolve(path)} (${Buffer.from(b64, 'base64').length} bytes)`);
    },
  },
  {
    name: 'images_process',
    description: 'Compress or convert local images through EditItAll\'s real codec pipeline. out: target format id (jpg|png|webp|avif|jxl|qoi) or "same" to recompress in place-format. Writes results next to the inputs (or into out_dir) and reports before/after sizes.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'absolute paths of input images' },
        out: { type: 'string', default: 'same' },
        quality: { type: 'number', default: 80 },
        max_dim: { type: 'number', description: 'optional max width/height (downscale)', default: 0 },
        out_dir: { type: 'string', description: 'optional output directory' },
      },
      required: ['paths'],
    },
    async run({ paths, out = 'same', quality = 80, max_dim = 0, out_dir }) {
      const t = await tab('tools');
      await t.evalJs(`window.__subtools.setOptions(${JSON.stringify({ out, quality, maxDim: max_dim })})`);
      await new Promise((r) => setTimeout(r, 700)); // let the settings effect settle
      const ids = [];
      for (const p of paths) {
        const bytes = readFileSync(resolve(p));
        const id = await t.evalJs(`window.__subtools.addBytes(${JSON.stringify(basename(p))}, ${JSON.stringify(bytes.toString('base64'))})`);
        ids.push({ id, src: resolve(p), inSize: bytes.length });
      }
      // poll until every file settles (done/error)
      const t0 = Date.now();
      let state;
      for (;;) {
        state = await t.evalJs('window.__subtools.state()');
        const mine = state.filter((f) => ids.some((x) => x.id === f.id));
        if (mine.length && mine.every((f) => f.status === 'done' || f.status === 'error')) break;
        if (Date.now() - t0 > 180000) return err('processing timed out after 180s');
        await new Promise((r) => setTimeout(r, 500));
      }
      const results = [];
      for (const x of ids) {
        const st = state.find((f) => f.id === x.id);
        if (st.status !== 'done') { results.push({ input: x.src, error: st.note || 'failed' }); continue; }
        const o = await t.evalJs(`window.__subtools.output(${x.id})`);
        const dir = out_dir ? resolve(out_dir) : dirname(x.src);
        mkdirSync(dir, { recursive: true });
        let dest = join(dir, o.name);
        if (dest === x.src) dest = join(dir, o.name.replace(/(\.[^.]+)$/, '.out$1'));
        writeFileSync(dest, Buffer.from(o.base64, 'base64'));
        results.push({ input: x.src, output: dest, inSize: x.inSize, outSize: st.outSize, saved: `${Math.round((1 - st.outSize / x.inSize) * 100)}%` });
      }
      return text(results);
    },
  },
  {
    name: 'editor_screenshot',
    description: 'Screenshot one of the editors so you can SEE the current state. app: sheet|vector|photo|tools|pdf|word|slides.',
    inputSchema: { type: 'object', properties: { app: { type: 'string', enum: Object.keys(APPS) } }, required: ['app'] },
    async run({ app }) {
      const t = await tab(app);
      const r = await t.send('Page.captureScreenshot', { format: 'webp', quality: 75 });
      return { content: [{ type: 'image', data: r.data, mimeType: 'image/webp' }] };
    },
  },
];

// ---------------------------------------------------------------- MCP stdio

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const replyErr = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'edititall', version: '0.2.0' },
      });
    } else if (method === 'notifications/initialized' || method?.startsWith('notifications/')) {
      // notifications need no reply
    } else if (method === 'ping') {
      reply(id, {});
    } else if (method === 'tools/list') {
      reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    } else if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return replyErr(id, -32602, `unknown tool ${params?.name}`);
      try {
        reply(id, await tool.run(params.arguments ?? {}));
      } catch (e) {
        reply(id, err(e?.message || String(e)));
      }
    } else if (id !== undefined) {
      replyErr(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    if (id !== undefined) replyErr(id, -32603, e?.message || 'internal error');
  }
});

process.on('exit', () => { try { chrome?.kill('SIGKILL'); } catch {} try { rmSync(PROFILE, { recursive: true, force: true }); } catch {} });
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
log(`ready — driving ${BASE} (chrome: ${existsSync(CHROME) ? 'found' : 'NOT FOUND, set CHROME_PATH'})`);
