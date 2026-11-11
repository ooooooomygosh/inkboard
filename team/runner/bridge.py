#!/usr/bin/env python3
"""One leased task at a time. Source credentials remain local; owner credentials never leave this machine."""
import threading, json, os, time, urllib.request, urllib.error, pathlib, subprocess, base64, ssl, hashlib

HOME = pathlib.Path.home() / ".inkboard-team"
CONFIG = json.loads((HOME / "config.json").read_text())
CURRENT = HOME / "current.json"


def save(v):
    p = CURRENT.with_suffix(".tmp")
    p.write_text(json.dumps(v, ensure_ascii=False))
    p.chmod(0o600)
    p.replace(CURRENT)


def request(base, path, key, body=None):
    req = urllib.request.Request(
        base + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "User-Agent": "InkBoard-Team/1",
        },
    )
    with urllib.request.urlopen(
        req, timeout=25, context=ssl.create_default_context(cafile="/etc/ssl/cert.pem")
    ) as r:
        return json.load(r)


def cloud(path, body):
    return request(CONFIG["url"], "/api/runner/" + path, CONFIG["runnerToken"], body)


last_sync = 0


def sync_repos():
    global last_sync
    if time.time() - last_sync < 300:
        return
    for repo in CONFIG["repos"]:
        context = {"repo": repo, "syncedAt": time.time()}
        for key, path in [
            ("metadata", ""),
            ("readme", "/readme"),
            ("issues", "/issues?state=open&per_page=8"),
            ("pulls", "/pulls?state=open&per_page=5"),
        ]:
            r = subprocess.run(
                ["gh", "api", "repos/" + repo + path],
                text=True,
                capture_output=True,
                timeout=30,
            )
            if r.returncode:
                context[key] = {"unavailable": True}
                continue
            d = json.loads(r.stdout)
            if key == "readme":
                context[key] = base64.b64decode(d["content"]).decode(
                    "utf8", errors="replace"
                )[:16000]
            elif key == "metadata":
                context[key] = {k: d.get(k) for k in ["default_branch", "pushed_at"]}
            else:
                context[key] = [
                    {k: v.get(k) for k in ["number", "title", "html_url"]} for v in d
                ]
        for filename in [
            "AGENTS.md",
            "CONTRIBUTING.md",
            "package.json",
            "docs/MEMORY_ARCHITECTURE.md",
            "docs/PERSONALITY.md",
        ]:
            rr = subprocess.run(
                ["gh", "api", "repos/" + repo + "/contents/" + filename],
                text=True,
                capture_output=True,
                timeout=20,
            )
            if rr.returncode == 0:
                data = json.loads(rr.stdout)
                if data.get("encoding") == "base64":
                    context.setdefault("files", {})[filename] = base64.b64decode(
                        data["content"]
                    ).decode("utf8", errors="replace")[:10000]
        branch = context.get("metadata", {}).get("default_branch")
        if branch:
            rr = subprocess.run(
                [
                    "gh",
                    "api",
                    "repos/" + repo + "/commits/" + branch + "/check-runs?per_page=20",
                ],
                text=True,
                capture_output=True,
                timeout=20,
            )
            if rr.returncode == 0:
                context["checks"] = [
                    {
                        k: v.get(k)
                        for k in [
                            "id",
                            "head_sha",
                            "name",
                            "status",
                            "conclusion",
                            "html_url",
                        ]
                    }
                    for v in json.loads(rr.stdout).get("check_runs", [])
                ]
        cloud("context", {"repo": repo, "context": context})
    last_sync = time.time()


def tick():
    t = json.loads(CURRENT.read_text()) if CURRENT.exists() else None
    if not t:
        t = cloud("claim", {}).get("task")
        if not t:
            return
        save(t)
    if not t.get("event"):
        a = request(
            CONFIG["hub"],
            "/v1/events",
            CONFIG["sourceKey"],
            {
                "id": hashlib.sha256(t["id"].encode()).hexdigest(),
                "type": "team.task",
                "subject": "task:" + hashlib.sha256(t["id"].encode()).hexdigest(),
                "summary": t["title"][:200],
                "detail": "任务资料在本机受限配置目录。",
            },
        )
        if not a.get("routed"):
            raise RuntimeError("No autoloop rule matched")
        t["event"] = a["event"]
        save(t)
    cloud("heartbeat", {"id": t["id"], "lease": t["lease"], "version": t["version"]})
    ev = request(CONFIG["hub"], "/v1/events/" + str(t["event"]), CONFIG["sourceKey"])
    runs = ev.get("runs", [])
    if runs and runs[-1]["state"] in ("done", "nothing", "cancelled"):
        result_path = (
            HOME / "results" / (hashlib.sha256(t["id"].encode()).hexdigest() + ".json")
        )
        result = (
            json.loads(result_path.read_text())
            if result_path.exists()
            else {
                "status": "needs_human",
                "result": "执行未留下完整结果，请检查本机 autoloop。",
            }
        )
        cloud(
            "report", dict(id=t["id"], lease=t["lease"], version=t["version"], **result)
        )
        CURRENT.unlink()


def sync_loop():
    while True:
        try:
            sync_repos()
        except Exception as e:
            print("repo sync", type(e).__name__, flush=True)
        time.sleep(30)


if __name__ == "__main__":
    threading.Thread(target=sync_loop, daemon=True).start()
    while True:
        try:
            tick()
        except urllib.error.HTTPError as e:
            print("bridge HTTP", e.code, flush=True)
            if e.code == 409 and CURRENT.exists():
                # Human changed the task or the lease expired. Preserve the handoff; never silently overwrite it.
                CURRENT.rename(HOME / ("conflict-" + str(int(time.time())) + ".json"))
        except Exception as e:
            print("bridge", type(e).__name__, flush=True)
        time.sleep(15)
