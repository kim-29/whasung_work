#!/usr/bin/env python3
"""도면 HTML 과 절단서를 화성 알루미늄 서버에 올린다. (표준 라이브러리만 사용)

[새 작업지시로 올리기]  서버에 오더가 새로 만들어지고 작업장에 알림이 간다.
    python upload_order.py new --html NS112.html --company 하나 --kind make --color 실버 \
        --items items.json --delete-glb NS112.glb

    --delete-glb : 업로드가 **성공한 뒤에만** 중간 재료인 .glb 를 지운다 (도면 HTML 안에 모델이 이미 들어 있다). 실패하면 남겨 둔다.

    items.json : [{"bar_name": "NS112SL104", "length_mm": 2000, "qty": 2}, ...]  (blender_scan 결과의 items 에서 members 는 빼도 된다)

[이미 올라간 작업의 도면만 바꾸기]
    python upload_order.py replace --order 7 --html NS112.html

접속 정보는 환경변수로 받는다 (코드나 파일에 적어 두지 않는다):
    WHASUNG_API_URL   서버 주소 (예: https://whasung-server.<계정>.workers.dev)
    WHASUNG_API_KEY   새 작업지시 올리기용 키 (서버의 BLENDER_API_KEY)
    WHASUNG_PIN       도면 바꾸기(replace)용 관리자/직원 PIN
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

COLORS = ("화이트", "블랙", "실버", "헨켈")


def die(msg, code=2):
    print(f"오류: {msg}", file=sys.stderr)
    sys.exit(code)


def need_env(name):
    v = os.environ.get(name, "").strip()
    if not v:
        die(f"환경변수 {name} 가 비어 있습니다.")
    return v


# Cloudflare 가 파이썬 기본 User-Agent(Python-urllib)를 봇으로 보고 HTTP 403 "error code: 1010" 으로 막는다.
# 이때는 서버(Worker)까지 가지 않아 작업지시도 생기지 않는다. 브라우저 형태의 User-Agent 를 붙여 보낸다.
DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) whasung-blender-upload",
    "Accept": "application/json",
}


def request(method, url, data=None, headers=None, timeout=300):
    req = urllib.request.Request(url, data=data, method=method, headers={**DEFAULT_HEADERS, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")


def load_items(path, color):
    with open(path, encoding="utf-8-sig") as f:  # utf-8-sig: Windows 에서 만든 파일 앞의 BOM 도 읽는다
        raw = json.load(f)
    items = []
    for i, it in enumerate(raw, 1):
        try:
            name, length, qty = str(it["bar_name"]), int(it["length_mm"]), int(it["qty"])
        except (KeyError, ValueError, TypeError):
            die(f"절단서 {i}번째 줄에 bar_name, length_mm(정수), qty(정수)가 필요합니다.")
        if length <= 0 or qty <= 0:
            die(f"절단서 {i}번째 줄의 길이와 수량은 1 이상이어야 합니다.")
        items.append({"bar_name": name, "length_mm": length, "qty": qty, "color": color})
    if not items:
        die("절단서가 비어 있습니다.")
    return items


def delete_glb(paths, dry_run=False):
    """업로드가 끝난 뒤 중간 재료인 .glb 파일을 지운다. 도면 HTML 안에 모델이 이미 들어 있어 서버·브라우저 보기에는 필요 없다.
    실수로 다른 파일을 지우지 않도록 확장자가 .glb 인 파일만 지운다."""
    for p in paths or []:
        if not p.lower().endswith(".glb"):
            print(f"건너뜀(.glb 파일이 아님): {p}")
        elif not os.path.isfile(p):
            print(f"이미 없음: {p}")
        elif dry_run:
            print(f"(--dry-run: 업로드 성공 시 지울 파일) {p}")
        else:
            os.remove(p)
            print(f"glb 삭제: {p}")


def cmd_new(a):
    base = need_env("WHASUNG_API_URL").rstrip("/")
    key = need_env("WHASUNG_API_KEY")
    with open(a.html, encoding="utf-8") as f:
        html = f.read()
    body = {
        "company": a.company, "kind": a.kind, "request_note": a.note,
        "items": load_items(a.items, a.color), "drawing_html": html,
    }
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    print(f"새 작업지시를 올립니다: {a.company} / {a.kind} / {a.color} / {len(body['items'])}줄 / {len(data) / 1024 / 1024:.2f}MB")
    if a.dry_run:
        print("(--dry-run: 서버로 보내지 않고 끝냅니다)")
        delete_glb(a.delete_glb, dry_run=True)
        return
    headers = {"Content-Type": "application/json; charset=utf-8", "X-API-Key": key}
    try:
        status, text = request("POST", base + "/api/ingest/blender", data, headers)
    except urllib.error.HTTPError as e:
        die(f"서버가 거절했습니다 (HTTP {e.code}): {e.read().decode('utf-8', 'replace')}", 1)
    except (urllib.error.URLError, OSError) as e:
        # 보내던 중 연결이 끊기면 서버가 이미 받았는지 알 수 없다. 자동 재시도하면 같은 작업이 두 번 접수될 수 있다.
        die(
            f"연결이 끊겼습니다 ({e}). 서버가 이미 받았을 수도 있으니 대시보드(또는 작업목록)에서 "
            f"'{a.company}' 작업이 생겼는지 먼저 확인하고, 없을 때만 다시 실행하세요.", 1,
        )
    r = json.loads(text)
    print(f"완료: 작업 번호 {', '.join(map(str, r['ids']))}, 예상 무게 {r['theory_weight']}kg, 상태 {r['status']}")
    if r.get("has_unknown_bar"):
        print("주의: 설정의 바(자재) 목록에 없는 바 이름이 있어 '미등록 바' 표시가 붙었습니다. 설정에서 바를 등록해 주세요.")
    delete_glb(a.delete_glb)  # 성공했을 때만 지운다 (실패하면 다시 시도할 수 있게 남겨 둔다)


def cmd_replace(a):
    base = need_env("WHASUNG_API_URL").rstrip("/")
    pin = need_env("WHASUNG_PIN")
    with open(a.html, "rb") as f:
        html = f.read()
    print(f"작업 {a.order} 의 도면을 교체합니다 ({len(html) / 1024 / 1024:.2f}MB)")
    if a.dry_run:
        print("(--dry-run: 서버로 보내지 않고 끝냅니다)")
        delete_glb(a.delete_glb, dry_run=True)
        return
    jh = {"Content-Type": "application/json"}
    try:
        _, text = request("POST", base + "/api/auth/login", json.dumps({"pin": pin, "label": "drawing-update"}).encode(), jh, 60)
    except urllib.error.HTTPError as e:
        die(f"로그인 실패 (HTTP {e.code}): {e.read().decode('utf-8', 'replace')}", 1)
    token = json.loads(text)["token"]
    auth = {"Authorization": f"Bearer {token}"}
    try:
        for attempt in range(1, a.retries + 1):  # 같은 도면을 덮어쓰는 것이라 다시 보내도 안전하다
            try:
                request("PUT", f"{base}/api/orders/{a.order}/drawing", html, {**auth, "Content-Type": "text/html; charset=utf-8"})
                print(f"완료: 작업 {a.order} 도면 교체 (시도 {attempt}번째)")
                delete_glb(a.delete_glb)  # 성공했을 때만 지운다
                return
            except urllib.error.HTTPError as e:
                die(f"서버가 거절했습니다 (HTTP {e.code}): {e.read().decode('utf-8', 'replace')}", 1)
            except (urllib.error.URLError, OSError) as e:
                print(f"시도 {attempt} 실패: {e}")
                time.sleep(2)
        die("여러 번 시도했지만 올리지 못했습니다. 잠시 후 다시 실행해 주세요.", 1)
    finally:  # 확인용으로 만든 로그인(기기 등록)은 항상 정리한다
        try:
            request("POST", base + "/api/auth/logout", b"{}", {**jh, **auth}, 30)
        except Exception:
            pass


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    n = sub.add_parser("new", help="새 작업지시로 올리기")
    n.add_argument("--html", required=True)
    n.add_argument("--company", required=True)
    n.add_argument("--kind", required=True, choices=("make", "cut"), help="make=제작(절단 포함), cut=절단")
    n.add_argument("--color", required=True, choices=COLORS)
    n.add_argument("--items", required=True, help="절단서 JSON 파일")
    n.add_argument("--note", default="", help="별도 요구사항")
    n.add_argument("--delete-glb", action="append", default=[], metavar="GLB", help="업로드 성공 후 지울 .glb 파일 (여러 번 지정 가능)")
    n.add_argument("--dry-run", action="store_true")
    n.set_defaults(fn=cmd_new)

    r = sub.add_parser("replace", help="이미 올라간 작업의 도면만 교체")
    r.add_argument("--order", required=True, type=int, help="작업 번호")
    r.add_argument("--html", required=True)
    r.add_argument("--retries", type=int, default=3)
    r.add_argument("--delete-glb", action="append", default=[], metavar="GLB", help="교체 성공 후 지울 .glb 파일 (여러 번 지정 가능)")
    r.add_argument("--dry-run", action="store_true")
    r.set_defaults(fn=cmd_replace)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
