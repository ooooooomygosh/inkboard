#!/usr/bin/env python3
"""Loopback-only owner view. Team invitations use the separate authenticated cloud site."""
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
import json, urllib.request, urllib.error, ssl

C = json.loads((Path.home() / ".inkboard-team/config.json").read_text())


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def proxy(self):
        if (
            self.headers.get("Host") != "127.0.0.1:3391"
            or self.headers.get("Origin", "http://127.0.0.1:3391")
            != "http://127.0.0.1:3391"
        ):
            self.send_error(403)
            return
        if not (
            self.path in ("/", "/guide")
            or self.path.startswith(("/api/team/", "/api/admin/"))
        ):
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length > 262144:
            self.send_error(413)
            return
        req = urllib.request.Request(
            C["url"] + self.path,
            data=self.rfile.read(length) if length else None,
            method=self.command,
            headers={
                "Authorization": "Bearer " + C["adminToken"],
                "Content-Type": "application/json",
                "User-Agent": "InkBoard-Team/1",
            },
        )
        try:
            r = urllib.request.urlopen(
                req,
                context=ssl.create_default_context(cafile="/etc/ssl/cert.pem"),
                timeout=30,
            )
        except urllib.error.HTTPError as e:
            r = e
        data = r.read()
        if self.path in ("/", "/guide"):
            data = data.replace(
                b"token=sessionStorage.getItem('team-token')||''",
                b"token='local-owner'",
            )
        self.send_response(r.status)
        self.send_header(
            "Content-Type", r.headers.get("Content-Type", "application/json")
        )
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        self.wfile.write(data)

    do_GET = proxy
    do_POST = proxy
    do_PATCH = proxy
    do_DELETE = proxy


HTTPServer(("127.0.0.1", 3391), Handler).serve_forever()
