//! `edititall-mcp` — spawn the embedded Node MCP server on stdio.

use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn find_node() -> PathBuf {
    if let Ok(p) = env::var("NODE") {
        return PathBuf::from(p);
    }
    PathBuf::from("node")
}

fn main() {
    let node = find_node();
    let script = {
        let mut p = env::temp_dir();
        p.push(format!("edititall-mcp-{}.mjs", std::process::id()));
        p
    };
    if let Err(e) = fs::write(&script, edititall_mcp::SERVER_JS) {
        let _ = writeln!(
            io::stderr(),
            "[edititall-mcp] failed to write embedded server to {}: {e}",
            script.display()
        );
        std::process::exit(1);
    }

    let status = Command::new(&node)
        .arg(&script)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status();

    let _ = fs::remove_file(&script);

    match status {
        Ok(s) => std::process::exit(s.code().unwrap_or(1)),
        Err(e) => {
            let _ = writeln!(
                io::stderr(),
                "[edititall-mcp] failed to spawn `{node}`: {e}\n\
                 Install Node.js 22+ and ensure `node` is on PATH, or set NODE to the binary.",
                node = node.display()
            );
            std::process::exit(1);
        }
    }
}
