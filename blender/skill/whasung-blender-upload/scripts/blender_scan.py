"""Blender 장면에서 바 목록(이름·길이·수량)과 치수선을 읽어 JSON 으로 출력한다.

Blender 안에서 실행한다 (Blender MCP 의 execute_blender_code 로 이 파일 내용을 실행).
장면을 수정하지 않고 읽기만 한다.

바 이름 규칙: 오브젝트 이름의 첫 '_' 앞부분이 바 종류다. (NS112SL104_Left -> NS112SL104, SC19_LR -> SC19)
치수선 규칙: 재질 이름이 DIM 으로 시작하거나, 이름이 D숫자_ 로 시작하거나, 메시가 아닌 오브젝트(글자 등).
길이: 오브젝트의 가장 긴 변을 mm 로 환산해 정수로 반올림한다. (서버는 정수 mm 만 받는다)
"""
import json
import re
from collections import OrderedDict

import bpy
from mathutils import Vector

unit_to_mm = bpy.context.scene.unit_settings.scale_length * 1000.0  # Blender 단위 -> mm


def is_dimension(ob):
    if ob.type != "MESH":
        return True  # 글자(FONT), 곡선, 카메라, 조명 등은 바가 아니다
    mats = [s.material.name for s in ob.material_slots if s.material]
    return any(m.upper().startswith("DIM") for m in mats) or re.match(r"^D\d+_", ob.name) is not None


groups = OrderedDict()  # (바 이름, 길이) -> [오브젝트 이름...]
warnings = []
dim_count = 0
mins = [float("inf")] * 3
maxs = [float("-inf")] * 3

for ob in bpy.data.objects:
    if is_dimension(ob):
        dim_count += 1
        continue
    base = re.sub(r"\.\d+$", "", ob.name.split("_")[0])  # '.001' 같은 복제 꼬리 제거
    length_mm = max(ob.dimensions) * unit_to_mm
    rounded = int(round(length_mm))
    if abs(length_mm - rounded) > 0.05:
        warnings.append(f"{ob.name}: 길이 {length_mm:.1f}mm 를 {rounded}mm 로 반올림")
    groups.setdefault((base, rounded), []).append(ob.name)
    for corner in ob.bound_box:  # 전체 크기(가로·세로)를 구하기 위한 월드 좌표 범위
        w = ob.matrix_world @ Vector(corner)
        for i in range(3):
            mins[i] = min(mins[i], w[i])
            maxs[i] = max(maxs[i], w[i])

items = [
    {"bar_name": base, "length_mm": length, "qty": len(names), "members": names}
    for (base, length), names in sorted(groups.items(), key=lambda kv: (kv[0][0], -kv[0][1]))
]

result = {"items": items, "dimension_objects": dim_count, "warnings": warnings}
# .blend 로 저장된 적이 없으면 모델의 보관본이 Blender 메모리뿐이다. 업로드 전에 사용자에게 저장을 권한다.
result["blend_saved"] = bool(bpy.data.filepath)
result["blend_path"] = bpy.data.filepath
if items:
    size = [round((maxs[i] - mins[i]) * unit_to_mm) for i in range(3)]
    result["overall_mm"] = {"x": size[0], "y": size[1], "z": size[2]}
    # 파일 이름 제안: 제품 접두어 + 가로x세로 (Blender 는 Z 가 위)
    prefix = next((m.group(0) for m in (re.match(r"^[A-Za-z]+\d+", it["bar_name"]) for it in items) if m), "model")
    result["suggested_name"] = f"{prefix}_{size[0]}x{size[2]}"
print(json.dumps(result, ensure_ascii=False))
