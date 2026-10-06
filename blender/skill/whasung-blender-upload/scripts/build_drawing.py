#!/usr/bin/env python3
"""glTF(.glb) 를 3D 뷰어 템플릿에 넣어 도면 HTML 한 장을 만든다. (표준 라이브러리만 사용)

예)
    python build_drawing.py --glb NS112_2000x1500.glb --color 실버 \
        --title "NS112 창문 2000 x 1500" --out NS112_2000x1500.html

- glb 는 gzip 으로 압축해서 넣는다 (파일이 1/3 수준으로 줄어 올리기·열기가 빨라진다).
- 색상은 주문 색상(화이트/블랙/실버/헨켈)이며 도면의 모든 바를 그 색으로 칠한다. 치수선은 항상 빨간색.
"""
import argparse
import base64
import gzip
import json
import os
import sys

COLORS = ("화이트", "블랙", "실버", "헨켈")
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TEMPLATE = os.path.join(HERE, "..", "assets", "viewer-template.html")


def build(glb_path, template_path, color, title, note=""):
    with open(template_path, encoding="utf-8") as f:
        html = f.read()
    for marker in ("/*__GLB__*/null", "/*__INFO__*/{}"):
        if marker not in html:
            raise SystemExit(f"템플릿에 {marker} 자리가 없습니다: {template_path}")
    with open(glb_path, "rb") as f:
        raw = f.read()
    packed = gzip.compress(raw, compresslevel=9, mtime=0)
    glb_b64 = base64.b64encode(packed).decode("ascii")
    info = {"title": title, "color": color}
    if note:
        info["note"] = note
    # json.dumps 로 감싸면 따옴표·역슬래시가 안전하게 이스케이프된다. '<' 는 </script> 방지를 위해 변환.
    html = html.replace("/*__GLB__*/null", json.dumps(glb_b64), 1)
    html = html.replace("/*__INFO__*/{}", json.dumps(info, ensure_ascii=False).replace("<", "\\u003c"), 1)
    return html, len(raw), len(packed)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--glb", required=True, help="Blender 에서 내보낸 .glb 파일")
    p.add_argument("--out", required=True, help="만들 도면 .html 파일")
    p.add_argument("--color", required=True, choices=COLORS, help="주문 색상")
    p.add_argument("--title", required=True, help="도면 화면 제목 (예: NS112 창문 2000 x 1500)")
    p.add_argument("--note", default="", help="제목 아래에 보일 설명 (선택)")
    p.add_argument("--template", default=DEFAULT_TEMPLATE, help="뷰어 템플릿 (기본: 스킬의 assets/viewer-template.html)")
    a = p.parse_args()

    html, raw_size, packed_size = build(a.glb, a.template, a.color, a.title, a.note)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(html)
    mb = lambda n: f"{n / 1024 / 1024:.2f}MB"
    print(f"만들었습니다: {a.out}")
    print(f"  glb {mb(raw_size)} -> 압축 {mb(packed_size)}, 도면 HTML {mb(len(html.encode('utf-8')))}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
