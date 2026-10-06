# 서버 규칙 · 뷰어 기능 · 문제 해결

## 목차
1. 서버 API (올리기에 쓰는 것)
2. 절단서 규칙
3. 도면 뷰어 기능
4. 문제 해결
5. 알려진 한계 / 앞으로 보완할 점

## 1. 서버 API

| 용도 | 요청 | 인증 |
|---|---|---|
| 새 작업지시 + 도면 | `POST /api/ingest/blender` (JSON) | 헤더 `X-API-Key` |
| 도면만 교체 | `PUT /api/orders/<번호>/drawing` (본문이 HTML 그대로) | 로그인 토큰(PIN 로그인 `POST /api/auth/login`) |

`POST /api/ingest/blender` 본문:
```json
{
  "company": "하나",
  "kind": "make",                       // make=제작(절단 포함), cut=절단
  "request_note": "",                   // 별도 요구사항 (선택)
  "items": [{"bar_name": "NS112SL104", "length_mm": 2000, "qty": 2, "color": "실버"}],
  "drawing_html": "<html>...</html>"    // 선택, 최대 약 10MB
}
```
응답: `{"id": 10, "ids": [10], "orders": [...], "theory_weight": 80.5, "has_unknown_bar": false, "status": "pending"}`

## 2. 절단서 규칙
- `color` 는 **화이트 / 블랙 / 실버 / 헨켈 / 기타** 중 하나이고 줄마다 필요하다.
- `length_mm`, `qty` 는 **양의 정수**.
- `kind: make`(제작) 는 색이 하나여야 한다. `cut`(절단) 은 색이 섞이면 서버가 색상별 작업으로 나누어 저장한다.
- 예상 무게(kg) = 바의 kg/m × 길이(mm)/1000 × 수량. 설정의 바 목록에 없는 이름은 0kg 이고 `has_unknown_bar: true`.
- 금액은 서버가 저장하지 않는다. 앱이 색상별 kg당 단가(설정)로 조회할 때 계산한다.

## 3. 도면 뷰어 기능 (assets/viewer-template.html)
- 데이터: `window.__GLB__`(gzip 압축한 glb 의 base64), `window.__INFO__`(제목, 색상, 설명).
- 바 종류별 묶음 + 바 하나하나 숨김/보임 체크박스, 처음에는 모두 접힘. 목록에 마우스를 올리면 해당 바가 주황색으로 깜빡인다.
- 치수선은 항상 빨간색, 목록 맨 아래의 "치수선" 묶음.
- 한 줄 컨트롤: 초기화면(시점과 숨긴 바 모두 되돌림) / Dark·White 배경 토글 / 감도(상·중·하). 선택은 브라우저에 기억된다.
- "패널 숨기기" 버튼으로 오른쪽(좁은 화면에서는 아래쪽) 패널을 접을 수 있다.
- 색상: 화이트 `#f1f2f3`, 블랙 `#1f2124`, 실버 `#c4cacf`, 헨켈(밝은 브론즈) `#c0a073`, 기타 `#8c9f7a`. 바꾸려면 프로젝트의 `blender/src/viewer.js` 의 `ORDER_COLORS` 를 고치고 `npm run build`(blender 폴더) 후 `dist/viewer-template.html` 을 이 스킬의 `assets/` 에 복사한다.
- 도면은 서버가 보안 설정(sandbox, 외부 통신 차단)을 붙여 내려주고, 앱에서는 10분짜리 서명 링크로 새 창에서 연다.

## 4. 문제 해결

| 증상 | 원인과 해결 |
|---|---|
| 올리다가 "연결이 끊겼습니다" | 새 작업지시는 자동 재시도하지 않는다. 앱에서 작업이 생겼는지 확인하고 없을 때만 다시 실행. 도면 교체(replace)는 자동 재시도됨 |
| HTTP 403 `error code: 1010` | Cloudflare 가 파이썬 기본 User-Agent 를 봇으로 보고 막은 것. 서버까지 가지 않아 작업지시는 생기지 않으므로 다시 보내도 된다. `upload_order.py` 는 브라우저 형태 User-Agent 를 붙여 보낸다 |
| "API 키/PIN 정보를 찾을 수 없습니다" | 설정이 비어 있음. `python scripts/upload_order.py setup --from-secrets-file <프로젝트>/server/.prod-secrets.json` 으로 한 번 저장(확인: `setup --show`). 설정은 환경변수(`WHASUNG_API_URL`/`WHASUNG_API_KEY`/`WHASUNG_PIN`) → `~/.whasung/config.json`(위치는 `WHASUNG_CONFIG` 로 변경) → 코드 기본값(서버 주소만) 순으로 읽는다 |
| HTTP 401 (API 키) | 저장된 `api_key`(또는 환경변수 `WHASUNG_API_KEY`)가 서버의 `BLENDER_API_KEY` 와 다름. 환경변수가 설정 파일보다 우선하니 둘 다 확인하고, 비밀값을 바꿨다면 `setup` 을 다시 실행 |
| 로그인 실패 / 잠김 | 저장된 `pin`(또는 `WHASUNG_PIN`)이 틀림. 5번 틀리면 잠기며 관리자가 설정에서 풀어야 한다 |
| "미등록 바" 경고 | 바 이름이 설정의 바 목록과 다름(하이픈·대소문자). 설정을 고치거나 앱 "내용 수정"에서 이름을 다시 골라 저장 |
| 도면에 바가 일부만 보임 / 치수선이 바와 섞임 | 오브젝트 이름·재질 이름이 규칙(위 SKILL.md)과 다름 |
| 도면이 너무 크다 (10MB 초과) | 모델의 메시가 너무 조밀함. Blender 에서 모디파이어/세분화를 줄이거나 Draco 압축을 검토 |
| 한글이 깨져 보임 | 터미널(코드페이지) 출력 문제일 가능성이 크다. 파일을 UTF-8 로 열어 확인 |

## 4-1. glb 파일 정리
- `.glb` 는 HTML 을 만드는 중간 재료다. 서버에는 HTML 만 올라가고, 폴더의 HTML 을 더블클릭해 브라우저로 볼 때도 glb 는 필요 없다(모델이 HTML 안에 gzip 으로 들어 있다).
- `upload_order.py ... --delete-glb <파일>.glb` 는 업로드가 성공한 뒤에만 그 glb 를 지운다(.glb 확장자만, 실패하면 남김).
- glb 가 다시 필요할 때(뷰어 수정 반영, 다른 색 도면)는 Blender 에서 다시 내보낸다. `.blend` 로 저장되어 있지 않으면 원본을 잃을 수 있으니 `blender_scan.py` 의 `blend_saved` 로 확인한다.

## 5. 알려진 한계 / 앞으로 보완할 점
- 바 위치(왼쪽/위 등)는 이름에 있을 때만 보인다. 이름이 `_1`, `_A` 인 바는 위치를 알 수 없어 목록에서 마우스를 올려 확인한다. 3D 좌표로 위치를 자동 표시하는 기능을 추가할 수 있다.
- 한 번에 색 하나만 올린다. 같은 모델의 여러 색은 색마다 반복한다.
- 길이는 정수 mm. 소수점이 필요하면 서버(`length_mm` 정수 제한)를 먼저 고쳐야 한다.
- 새 작업지시 업로드는 중복 방지 장치(멱등 키)가 없어 재시도를 사람이 판단해야 한다.
