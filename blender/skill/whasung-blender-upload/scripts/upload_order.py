#!/usr/bin/env python3
"""도면 HTML 과 절단서를 화성 알루미늄 서버에 올린다. (표준 라이브러리만 사용)

[새 작업지시로 올리기]  서버에 오더가 새로 만들어지고 작업장에 알림이 간다.
    python upload_order.py new --html NS112.html --company 하나 --kind make --color 실버 \
        --items items.json --delete-glb NS112.glb

    --delete-glb : 업로드가 **성공한 뒤에만** 중간 재료인 .glb 를 지운다 (도면 HTML 안에 모델이 이미 들어 있다). 실패하면 남겨 둔다.

    items.json : [{"bar_name": "NS112SL104", "length_mm": 2000, "qty": 2}, ...]  (blender_scan 결과의 items 에서 members 는 빼도 된다)

[이미 올라간 작업의 도면만 바꾸기]
    python upload_order.py replace --order 7 --html NS112.html

[접속 정보를 한 번만 저장해 두기]
    python upload_order.py setup --from-secrets-file <프로젝트>/server/.prod-secrets.json
    python upload_order.py setup --show        # 저장된 항목 확인 (비밀 값은 보여 주지 않는다)

접속 정보는 아래 순서로 찾는다 (앞에 있는 것이 우선):
    1) 환경변수  WHASUNG_API_URL / WHASUNG_API_KEY / WHASUNG_PIN
    2) 내 컴퓨터의 설정 파일  ~/.whasung/config.json  (setup 으로 만든다. 환경변수 WHASUNG_CONFIG 로 위치를 바꿀 수 있다)
    3) 서버 주소만 코드의 기본값 (공개된 주소라 코드에 있어도 안전하다)

    WHASUNG_API_KEY   새 작업지시 올리기용 키 (서버의 BLENDER_API_KEY)  ← 비밀. 코드·저장소에 절대 넣지 않는다
    WHASUNG_PIN       도면 바꾸기(replace)용 PIN (직원 PIN 을 권한다. 관리자 PIN 은 권한이 너무 크다)  ← 비밀
"""
import argparse
import getpass
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

COLORS = ("화이트", "블랙", "실버", "헨켈", "기타")

# 서버 주소는 앱 화면에도 들어 있는 공개 주소라 기본값으로 둔다. 다른 서버를 쓰면 환경변수나 설정 파일로 덮어쓴다.
DEFAULT_API_URL = "https://whasung-server.nameofwind.workers.dev"


def die(msg, code=2):
    print(f"오류: {msg}", file=sys.stderr)
    sys.exit(code)


# ---------- 접속 정보 (환경변수 > 설정 파일 > 기본값) ----------
def config_path():
    env = os.environ.get("WHASUNG_CONFIG", "").strip()
    return pathlib.Path(env) if env else pathlib.Path.home() / ".whasung" / "config.json"


def read_config():
    path = config_path()
    if not path.is_file():
        return {}
    try:
        with open(path, encoding="utf-8-sig") as f:  # utf-8-sig: 메모장으로 만든 파일의 BOM 도 읽는다
            data = json.load(f)
    except (OSError, ValueError) as e:
        die(f"설정 파일을 읽을 수 없습니다 ({path}): {e}")
    return data if isinstance(data, dict) else {}


# 설정 항목: (환경변수, 설정 파일의 이름, 기본값, 사람이 읽는 이름)
SETTINGS = {
    "api_url": ("WHASUNG_API_URL", "api_url", DEFAULT_API_URL, "서버 주소"),
    "api_key": ("WHASUNG_API_KEY", "api_key", None, "API 키"),
    "pin": ("WHASUNG_PIN", "pin", None, "PIN"),
}


def lookup(name):
    """(값, 어디서 왔는지) 를 돌려준다. 없으면 ('', None)"""
    env_name, file_key, default, _ = SETTINGS[name]
    v = os.environ.get(env_name, "").strip()
    if v:
        return v, "환경변수"
    v = str(read_config().get(file_key, "")).strip()
    if v:
        return v, "설정 파일"
    if default:
        return default, "기본값"
    return "", None


def setting(name):
    v, _ = lookup(name)
    if not v:
        env_name, _, _, label = SETTINGS[name]
        die(
            f"{label} 정보를 찾을 수 없습니다. 환경변수 {env_name} 를 설정하거나, 한 번만 "
            f"`python upload_order.py setup --from-secrets-file <server/.prod-secrets.json>` 를 실행해 내 컴퓨터에 저장해 두세요."
        )
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
    base = setting("api_url").rstrip("/")
    key = setting("api_key")
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
    base = setting("api_url").rstrip("/")
    pin = setting("pin")
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
    except (urllib.error.URLError, OSError) as e:
        die(f"서버에 연결할 수 없습니다 ({e}). 서버 주소와 인터넷 연결을 확인해 주세요. (주소: {base})", 1)
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


def cmd_setup(a):
    """접속 정보를 내 컴퓨터의 설정 파일에 저장한다. 값은 화면에 출력하지 않는다."""
    path = config_path()
    if a.show:
        print(f"설정 파일: {path} ({'있음' if path.is_file() else '없음'})")
        for name, (env_name, _, _, label) in SETTINGS.items():
            v, src = lookup(name)
            shown = v if name == "api_url" else ("설정됨" if v else "없음")  # 서버 주소만 보여 주고, 키·PIN 은 값을 숨긴다
            print(f"  {label:<8} {shown}" + (f"  (출처: {src})" if v else f"  ← {env_name} 또는 setup 필요"))
        return

    cfg = read_config()
    saved = []
    if a.url:
        cfg["api_url"] = a.url.strip().rstrip("/")
        saved.append("api_url")
    if a.from_secrets_file:
        try:
            with open(a.from_secrets_file, encoding="utf-8-sig") as f:
                secrets = json.load(f)
        except (OSError, ValueError) as e:
            die(f"비밀값 파일을 읽을 수 없습니다: {e}")
        if secrets.get("BLENDER_API_KEY"):
            cfg["api_key"] = secrets["BLENDER_API_KEY"]
            saved.append("api_key")
        if a.with_admin_pin and secrets.get("ADMIN_PIN"):
            cfg["pin"] = secrets["ADMIN_PIN"]
            saved.append("pin")
    elif not a.url and sys.stdin.isatty():
        # 터미널에서 직접 실행했을 때: 입력한 글자가 화면에 보이지 않게 받는다 (빈 칸은 건너뜀)
        key = getpass.getpass("API 키(BLENDER_API_KEY, 건너뛰려면 Enter): ").strip()
        pin = getpass.getpass("PIN(도면 교체용 직원 PIN, 건너뛰려면 Enter): ").strip()
        if key:
            cfg["api_key"] = key
            saved.append("api_key")
        if pin:
            cfg["pin"] = pin
            saved.append("pin")
    if not saved:
        die("저장할 내용이 없습니다. --from-secrets-file <비밀값 파일> 또는 --url 을 지정하거나, 터미널에서 직접 실행해 입력하세요.")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)  # 나만 읽도록 (Windows 는 내 사용자 폴더 권한을 따른다)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    print(f"저장했습니다: {path}")
    print(f"저장된 항목: {', '.join(saved)} (값은 출력하지 않습니다)")
    print("주의: 이 파일은 내 컴퓨터에만 두세요. 저장소(GitHub)나 메신저로 보내지 마세요.")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("setup", help="접속 정보를 내 컴퓨터에 한 번만 저장")
    s.add_argument("--show", action="store_true", help="저장된 항목 확인 (키·PIN 값은 보여 주지 않음)")
    s.add_argument("--url", help="서버 주소 (바꿀 때만. 기본값이 코드에 있다)")
    s.add_argument("--from-secrets-file", metavar="FILE", help="서버 프로젝트의 .prod-secrets.json 에서 API 키를 복사")
    s.add_argument("--with-admin-pin", action="store_true", help="위 파일의 ADMIN_PIN 도 복사 (권한이 큰 PIN 이라 직원 PIN 사용을 권한다)")
    s.set_defaults(fn=cmd_setup)

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
