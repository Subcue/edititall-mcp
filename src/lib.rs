//! MCP launcher for [EditItAll](https://edititall.com) — a free, local-first
//! suite of in-browser editors (photo, vector, PDF, spreadsheet, Word, slides,
//! image convert/compress) built by [Subcue AI LLC](https://subcueai.com).
//!
//! Install the binary with `cargo install edititall-mcp`, then point any MCP
//! client at it:
//!
//! ```text
//! claude mcp add edititall -- edititall-mcp
//! ```
//!
//! This crate **wraps** the zero-dependency Node server shipped in this repo
//! (`edititall-mcp.mjs`). The binary embeds that script, writes it to a temp
//! file, and execs `node`. You still need:
//!
//! - **Node.js 22+** on `PATH` (or set `NODE`)
//! - **Chrome / Edge / Chromium / Brave** (auto-detected, or set `CHROME_PATH`)
//!
//! The Node process launches a local headless Chrome and drives EditItAll's
//! official automation hooks. **Files never leave the machine.**
//!
//! Product docs: <https://edititall.com/ai>
//!
//! Env vars (forwarded to the Node server):
//!
//! - `EDITITALL_URL` — editor origin (default `https://edititall.com`)
//! - `CHROME_PATH` — browser binary
//! - `NODE` — Node executable (default `node` on `PATH`)

/// The MCP stdio server script embedded in this crate. Written to a temp file
/// at runtime and executed with Node.js 22+.
pub const SERVER_JS: &str = include_str!("../edititall-mcp.mjs");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_server_identifies_itself() {
        assert!(
            SERVER_JS.contains("serverInfo"),
            "embedded script must be the EditItAll MCP server"
        );
        assert!(SERVER_JS.contains("edititall"));
        assert!(SERVER_JS.contains("sheet_set_cells"));
        assert!(SERVER_JS.contains("images_process"));
    }
}
