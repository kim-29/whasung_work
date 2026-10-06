"""Blender(또는 일반 Python)에서 서버로 오더를 전송하는 참고 구현. 표준 라이브러리만 사용.

환경변수:
  WHASUNG_API_URL   예) https://whasung-server.<계정>.workers.dev
  WHASUNG_API_KEY   서버의 BLENDER_API_KEY 값
  WHASUNG_TEMPLATE  (선택) viewer-template.html 경로. 기본: 이 파일 옆 dist/viewer-template.html

Blender 안에서:
  import send_order as so
  bars = so.collect_bars(bpy.context.selected_objects)   # 바 메시를 도면 데이터로 변환
  items = [{"bar_name": "NS88-A", "length_mm": 2000, "qty": 4, "color": "화이트"}]
  so.send_order("한빛샷시", "make", items, bars, content="2짝 창", title="한빛샷시 2000x1500")

단독 테스트: python send_order.py --demo [--out demo.html] [--send]
"""
import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.environ.get("WHASUNG_TEMPLATE", os.path.join(HERE, "dist", "viewer-template.html"))


def _hex(color):
    r, g, b = [max(0, min(255, int(round(c * 255)))) for c in color[:3]]
    return "#%02x%02x%02x" % (r, g, b)


def collect_bars(objects, name_prop="bar_name", color_prop="bar_color"):
    """Blender 메시 오브젝트 -> 도면용 바 데이터(단위 mm).

    바 이름은 오브젝트 커스텀 속성 `bar_name`(없으면 오브젝트 이름에서 '.001' 같은 꼬리를 뗀 값),
    색상은 `bar_color`(#rrggbb, 없으면 첫 머티리얼 색)를 사용한다.
    Blender 단위가 m 이면 scale 로 1000을 준다(아래 unit_scale).
    """
    import bpy  # noqa: F401  (Blender 안에서만 사용)
    import bmesh

    unit_scale = 1000.0 * bpy.context.scene.unit_settings.scale_length
    result = []
    for ob in objects:
        if ob.type != "MESH":
            continue
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bm.transform(ob.matrix_world)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        verts, index = [], {}
        positions, indices = [], []
        for f in bm.faces:
            for v in f.verts:
                if v.index not in index:
                    index[v.index] = len(verts)
                    verts.append(v.index)
                    positions += [round(c * unit_scale, 2) for c in v.co]
                indices.append(index[v.index])
        dims = [d * unit_scale for d in ob.dimensions]
        bm.free()
        name = ob.get(name_prop) or ob.name.rsplit(".", 1)[0]
        color = ob.get(color_prop)
        if not color and ob.active_material:
            color = _hex(ob.active_material.diffuse_color)
        result.append({
            "id": ob.name, "name": name, "length": round(max(dims), 1),
            "color": color or "#c8ccd0", "positions": positions, "indices": indices,
        })
    return result


def build_drawing_html(bars, info=None, template_path=TEMPLATE):
    with open(template_path, encoding="utf-8") as f:
        html = f.read()
    # </script> 로 HTML 이 깨지지 않도록 '<' 를 이스케이프
    data = json.dumps(bars, separators=(",", ":")).replace("<", "\\u003c")
    meta = json.dumps(info or {}, ensure_ascii=False).replace("<", "\\u003c")
    return html.replace("/*__BARS__*/[]", data, 1).replace("/*__INFO__*/{}", meta, 1)


def send_order(company, kind, items, bars=None, content="", request_note="", title=None,
               api_url=None, api_key=None):
    """kind: 'cut'(절단만) | 'make'(제작). items: [{bar_name, length_mm, qty, color}]"""
    api_url = (api_url or os.environ["WHASUNG_API_URL"]).rstrip("/")
    api_key = api_key or os.environ["WHASUNG_API_KEY"]
    body = {"company": company, "kind": kind, "content": content,
            "request_note": request_note, "items": items}
    if bars:
        body["drawing_html"] = build_drawing_html(bars, {"title": title or company})
    req = urllib.request.Request(
        api_url + "/api/ingest/blender", data=json.dumps(body).encode("utf-8"), method="POST",
        headers={
            "Content-Type": "application/json",
            "X-API-Key": api_key,
            # Cloudflare 가 파이썬 기본 User-Agent(Python-urllib)를 봇으로 보고 403 "error code: 1010" 으로 막는다.
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) whasung-send-order",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError("서버 오류 %s: %s" % (e.code, e.read().decode("utf-8", "replace")))


def _box(x, y, z, dx, dy, dz):
    v = [(x + a * dx, y + b * dy, z + c * dz) for a in (0, 1) for b in (0, 1) for c in (0, 1)]
    positions = [round(c, 2) for p in v for c in p]
    f = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1),
         (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
    return positions, [i for t in f for i in t]


def demo_bars():
    """창틀 모양 샘플: 위/아래 2000mm, 좌/우 1500mm (바 이름이 같으면 패널에서 한 줄로 묶임)"""
    spec = [("NS88-A", 2000, (0, 0, 0, 2000, 88, 40), "#9aa4ae"), ("NS88-A", 2000, (0, 0, 1460, 2000, 88, 40), "#9aa4ae"),
            ("NS88-B", 1380, (0, 0, 40, 40, 88, 1420), "#b08d57"), ("NS88-B", 1380, (1960, 0, 40, 40, 88, 1420), "#b08d57")]
    bars = []
    for i, (name, length, box, color) in enumerate(spec):
        p, idx = _box(*box)
        bars.append({"id": "%s.%d" % (name, i), "name": name, "length": length, "color": color,
                     "positions": p, "indices": idx})
    return bars


if __name__ == "__main__":
    if "--demo" in sys.argv:
        out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else "demo.html"
        with open(out, "w", encoding="utf-8") as f:
            f.write(build_drawing_html(demo_bars(), {"title": "데모 창틀", "note": "2000 x 1500"}))
        print("작성:", out)
        if "--send" in sys.argv:
            items = [{"bar_name": "NS88-A", "length_mm": 2000, "qty": 2, "color": "화이트"},
                     {"bar_name": "NS88-B", "length_mm": 1380, "qty": 2, "color": "화이트"}]
            print(send_order("데모업체", "make", items, demo_bars(), title="데모 창틀"))
    else:
        print(__doc__)
