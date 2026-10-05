#!/usr/bin/env python3
"""Static server with SPA fallback: any non-existent path returns index.html."""
import http.server
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

class SPAHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        # If the requested file doesn't exist, fall back to index.html
        url_path = self.path.split("?", 1)[0].split("#", 1)[0]
        rel = url_path.lstrip("/")
        target = ROOT / rel
        if rel and not target.exists():
            self.path = "/index.html"
        return super().do_GET()

if __name__ == "__main__":
    with http.server.ThreadingHTTPServer(("", PORT), SPAHandler) as httpd:
        print(f"serving {ROOT} on http://localhost:{PORT}/  (SPA fallback enabled)")
        httpd.serve_forever()
