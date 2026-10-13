#!/usr/bin/env python3
"""GitHub Git Data API 推送（增量 commit）+ tag 创建。

本机 github.com:443 不可达，git push 走不通；api.github.com 通。
用法：
  python _push191.py                # 推送当前 HEAD 到 main（要求远端 main == HEAD^）
  python _push191.py --tag v1.9.1   # 创建 tag ref 指向本地 HEAD
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

REPO = "2026heshao/dsh-armory"
BRANCH = "main"
REPO_DIR = os.path.dirname(os.path.abspath(__file__))
TOKEN = os.environ.get("GH_TOKEN", "").strip()
API = "https://api.github.com"


def git(*args, binary=False):
    out = subprocess.run(["git", "-C", REPO_DIR, *args], capture_output=True, check=True)
    return out.stdout if binary else out.stdout.decode("utf-8", "replace")


def api(method, path, payload=None, retries=5):
    url = path if path.startswith("http") else API + path
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Authorization", "Bearer " + TOKEN)
        req.add_header("User-Agent", "dsh-armory-push")
        req.add_header("Accept", "application/vnd.github+json")
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:400]
            if exc.code < 500 and exc.code != 429:
                raise SystemExit(f"API {method} {url} -> {exc.code}: {detail}")
            last = f"{exc.code}: {detail}"
        except Exception as exc:  # noqa: BLE001
            last = str(exc)
        time.sleep(1.5 * (attempt + 1))
    raise SystemExit(f"API {method} {url} failed after {retries}: {last}")


def tree_entries(rev):
    out = git("ls-tree", "-z", rev, binary=True)
    entries = {}
    for item in out.split(b"\0"):
        if not item:
            continue
        meta, name = item.split(b"\t", 1)
        mode, typ, sha = meta.decode().split()
        entries[name.decode("utf-8")] = (mode, typ, sha)
    return entries


def push_commit():
    head = git("rev-parse", "HEAD").strip()
    parent = git("rev-parse", "HEAD^").strip()
    local_tree = git("rev-parse", "HEAD^{tree}").strip()
    remote_sha = api("GET", f"/repos/{REPO}/git/ref/heads/{BRANCH}")["object"]["sha"]
    print(f"HEAD={head[:8]} HEAD^={parent[:8]} remote={remote_sha[:8]}")
    if remote_sha != parent:
        # 远端与本地 HEAD^ 的 tree 相同即内容等价（SHA 差异只来自时区编码）
        remote_tree = api("GET", f"/repos/{REPO}/git/commits/{remote_sha}")["tree"]["sha"]
        local_parent_tree = git("rev-parse", f"{parent}^{{tree}}").strip()
        if remote_tree != local_parent_tree:
            raise SystemExit("远端与本地分叉且内容不同，拒绝推送")
        print(f"注意：远端 SHA 与本地 HEAD^ 不同但 tree 相同（{remote_tree[:8]}），按 fast-forward 处理")

    raw = git("diff", "--name-only", "-z", parent, head, binary=True)
    changed = [p.decode("utf-8") for p in raw.split(b"\0") if p]
    print(f"变更 {len(changed)} 个文件：{changed}")
    for path in changed:
        content = git("cat-file", "blob", f"{head}:{path}", binary=True)
        local_blob = git("rev-parse", f"{head}:{path}").strip()
        res = api("POST", f"/repos/{REPO}/git/blobs", {
            "content": base64.b64encode(content).decode("ascii"), "encoding": "base64"})
        if res["sha"] != local_blob:
            raise SystemExit(f"blob 不一致 {path}")
        print(f"  blob {path} ok")

    dirs = set()
    for path in changed:
        parts = path.split("/")
        for i in range(len(parts)):
            dirs.add("/".join(parts[:i]))
    cache = {}

    def rebuild(prefix):
        if prefix in cache:
            return cache[prefix]
        rev = f"{head}:{prefix}" if prefix else f"{head}^{{tree}}"
        items = []
        for name, (mode, typ, sha) in tree_entries(rev).items():
            child = f"{prefix}/{name}" if prefix else name
            if typ == "tree" and child in dirs:
                sha = rebuild(child)
            items.append({"path": name, "mode": mode, "type": typ, "sha": sha})
        res = api("POST", f"/repos/{REPO}/git/trees", {"tree": items})
        cache[prefix] = res["sha"]
        print(f"  tree {prefix or '<root>'} -> {res['sha'][:8]}")
        return res["sha"]

    root = rebuild("")
    if root != local_tree:
        raise SystemExit(f"根 tree 不一致 {root} != {local_tree}（已中止）")
    print(f"根 tree 校验通过 {root}")
    msg = git("log", "-1", "--format=%B", head).rstrip("\n")
    name = git("log", "-1", "--format=%an", head).strip()
    email = git("log", "-1", "--format=%ae", head).strip()
    date = git("log", "-1", "--format=%aI", head).strip()
    commit = api("POST", f"/repos/{REPO}/git/commits", {
        "message": msg, "tree": root, "parents": [remote_sha],
        "author": {"name": name, "email": email, "date": date},
        "committer": {"name": name, "email": email, "date": date}})
    api("PATCH", f"/repos/{REPO}/git/refs/heads/{BRANCH}", {"sha": commit["sha"], "force": False})
    print(f"main -> {commit['sha']}")
    subprocess.run(["git", "-C", REPO_DIR, "update-ref", f"refs/remotes/origin/{BRANCH}", head], check=True)


def push_tag(tag):
    head = git("rev-parse", "HEAD").strip()
    existing = None
    try:
        existing = api("GET", f"/repos/{REPO}/git/ref/tags/{urllib.parse.quote(tag)}")
    except SystemExit:
        existing = None
    if existing:
        print(f"tag {tag} 已存在 -> {existing['object']['sha'][:8]}，未改动")
        return
    res = api("POST", f"/repos/{REPO}/git/refs", {"ref": f"refs/tags/{tag}", "sha": head})
    print(f"tag {tag} -> {res['object']['sha']}")
    subprocess.run(["git", "-C", REPO_DIR, "update-ref", f"refs/tags/{tag}", head], check=False)


def main():
    if not TOKEN:
        raise SystemExit("GH_TOKEN 未设置")
    if "--tag" in sys.argv:
        push_tag(sys.argv[sys.argv.index("--tag") + 1])
    else:
        push_commit()


if __name__ == "__main__":
    main()
