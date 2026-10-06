"""현재 Blender 장면을 glTF(.glb)로 내보낸다. Blender 안에서 실행한다 (execute_blender_code).

사용법 (Blender MCP 에서):
    ns = {"OUT_NAME": "NS112_2000x1500"}          # 확장자 없는 파일 이름 (필수)
    # 선택: ns["OUT_DIR"] = r"C:\\원하는\\폴더"      (기본은 바탕화면의 model 폴더)
    exec(open(r"<이 파일 경로>", encoding="utf-8").read(), ns)

장면은 수정하지 않는다. 결과(JSON 한 줄)에 만든 파일 경로와 크기가 나온다.
"""
import json
import os

import bpy

_ns = globals()
out_name = _ns.get("OUT_NAME")
if not out_name:
    raise RuntimeError("OUT_NAME(확장자 없는 파일 이름)을 지정해 주세요.")

out_dir = _ns.get("OUT_DIR")
if not out_dir:
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, "Desktop"),
        os.path.join(home, "OneDrive", "Desktop"),
        os.path.join(home, "바탕 화면"),
        os.path.join(home, "OneDrive", "바탕 화면"),
    ]
    desktop = next((p for p in candidates if os.path.isdir(p)), None)
    if desktop is None:
        raise RuntimeError("바탕화면 폴더를 찾지 못했습니다. OUT_DIR 로 저장할 폴더를 지정해 주세요.")
    out_dir = os.path.join(desktop, "model")

os.makedirs(out_dir, exist_ok=True)
path = os.path.join(out_dir, out_name + ".glb")

bpy.ops.export_scene.gltf(
    filepath=path,
    export_format="GLB",       # 파일 하나로 묶인 glTF
    use_selection=False,       # 장면 전체
    export_apply=True,         # 모디파이어 적용
    export_cameras=False,
    export_lights=False,
    export_yup=True,           # glTF 표준(Y 가 위)
)
print(json.dumps({"glb": path, "bytes": os.path.getsize(path)}, ensure_ascii=False))
