---
name: whasung-blender-upload
description: Blender(MCP)에서 만든 알루미늄 창호 3D 도면을 화성 알루미늄 서버에 작업지시로 올리는 스킬. Blender 장면에서 바 이름·길이·수량(절단서)을 읽고, 장면을 glTF(.glb)로 내보내 3D 뷰어 HTML 도면을 만든 뒤, 업체명·작업종류·색상(화이트/블랙/실버/헨켈/기타)과 함께 서버에 업로드한다. 이미 올라간 작업의 도면만 새 버전으로 교체하는 것도 한다. 사용자가 "도면 서버에 올려줘", "블렌더 도면 업로드", "작업지시로 올려줘", "도면 html 만들어줘", "glb로 내보내서 올려", "화이트/블랙/실버/헨켈/기타 도면 하나 더 만들어줘", "올린 도면 다시 올려줘", "절단서 서버 전송"처럼 Blender 모델을 작업장·대리점 앱에 보내려는 말을 하면, 스킬 이름을 직접 말하지 않아도 반드시 이 스킬을 사용한다.
---

# 화성 알루미늄 · Blender 도면 → 서버 업로드

Blender 에 만든 창호 모델 하나를 **작업지시 1건 + 3D 도면 HTML**로 서버에 올린다. 작업장은 앱의 작업목록에서
절단서와 3D 도면(바별 숨김/표시, 치수선)을 보고 작업한다.

```
Blender 장면 ──(1) 읽기──▶ 절단서(바 이름·길이·수량)
            ──(2) glTF 내보내기──▶ .glb ──(3) 뷰어에 넣기──▶ 도면 .html ──(4) 업로드──▶ 서버
```

스크립트는 이 스킬 폴더의 `scripts/` 에 있다 (스킬이 열릴 때 알려 주는 Base directory 기준).
Blender 안에서 도는 코드(`blender_*.py`)와 컴퓨터에서 도는 코드(`build_drawing.py`, `upload_order.py`)로 나뉜다.

## 준비 (한 번만)

업로드에는 접속 정보(서버 주소, API 키, PIN)가 필요하다. 한 번만 내 컴퓨터의 설정 파일(`~/.whasung/config.json`)에 저장해 두면 매번 줄 필요가 없다.

- 서버 주소는 코드에 기본값이 들어 있다(공개 주소라 안전). 키·PIN은 비밀이므로 코드·스킬 파일·대화에 절대 적지 않고, 값 자체를 화면에 출력하지 않는다.
- 처음 한 번, 사용자에게 확인받고 실행한다 (서버 프로젝트의 `server/.prod-secrets.json` 에서 읽는다):

```
python scripts/upload_order.py setup --from-secrets-file <프로젝트>/server/.prod-secrets.json
python scripts/upload_order.py setup --show      # 저장된 항목 확인 (비밀 값은 보이지 않는다)
```

설정은 환경변수 → 설정 파일(`WHASUNG_CONFIG` 로 위치 변경) → 코드 기본값 순으로 읽는다. 환경변수가 있으면 설정 파일보다 우선한다.

| 환경변수 | 용도 |
|---|---|
| `WHASUNG_API_URL` | 서버 주소 (기본값이 코드에 있어 보통 생략) |
| `WHASUNG_API_KEY` | 새 작업지시 올리기 (서버의 `BLENDER_API_KEY`) |
| `WHASUNG_PIN` | 도면 교체(replace) 에만 필요. 직원 PIN 권장(관리자 PIN은 권한이 너무 큼) |

## 작업 순서

### 1. Blender 장면 읽기
`blender_scan.py` 를 Blender MCP(`execute_blender_code`)로 실행한다. Blender 는 같은 컴퓨터에서 돌므로 파일을 직접 읽어 실행할 수 있다:

```python
exec(open(r"<Base directory>\scripts\blender_scan.py", encoding="utf-8").read())
```

결과(JSON)에 바 목록(`items`), 치수선 개수, 전체 크기, 파일 이름 제안(`suggested_name`), 반올림 경고, `.blend` 저장 여부(`blend_saved`)가 나온다.
`blend_saved` 가 `false` 이면 모델이 Blender 메모리에만 있다는 뜻이므로, 업로드 전에 사용자에게 `.blend` 로 저장해 두라고 권한다 (이 스킬은 업로드 뒤 glb 를 지우므로, 저장하지 않으면 나중에 도면을 고칠 원본이 없다).
표로 사용자에게 보여 주고 맞는지 확인한다. 이름은 Blender 이름 그대로 쓰고, 길이는 **정수 mm**(서버가 정수만 받는다)로 반올림한다.
장면은 읽기만 하며 수정하지 않는다 — 사용자가 만든 도면이므로 건드리면 안 된다.

### 2. 필요한 정보를 하나씩 묻기
사용자는 질문을 **한 번에 하나씩**, 고를 수 있는 것은 **선택지**로 받기를 원한다 (AskUserQuestion).
- 업체명 (직접 입력)
- 작업 종류: 제작(절단 포함, 기본) / 절단
- 색상: 화이트 / 블랙 / 실버 / 헨켈 / 기타 (Blender 바에는 색 정보가 없어서 반드시 묻는다)

한 작업은 색상이 하나다. 같은 모델을 여러 색으로 올리려면 색마다 3~5단계를 반복한다.

### 3. glTF 내보내기
```python
ns = {"OUT_NAME": "<suggested_name>"}      # 색을 나눠 올릴 땐 뒤에 _white, _black 처럼 붙인다
exec(open(r"<Base directory>\scripts\blender_export.py", encoding="utf-8").read(), ns)
```
기본 저장 위치는 바탕화면의 `model` 폴더이며, 다른 곳은 `ns["OUT_DIR"]` 로 지정한다.
이 `.glb` 는 도면 HTML 을 만들기 위한 **중간 재료**다. HTML 안에 모델이 압축되어 들어가므로, 업로드가 끝나면 지운다 (6단계).
같은 이름의 파일이 있으면 덮어쓴다.

### 4. 도면 HTML 만들기
```
python scripts/build_drawing.py --glb <파일>.glb --color <색상> --title "<제목>" --out <파일>.html
```
glb 는 gzip 으로 압축해 넣으므로 보통 7MB → 2MB 정도가 된다. 모든 바는 주문 색으로, 치수선은 빨간색으로 칠해진다.

### 5. (권장) 미리보기
`python -m http.server` 로 폴더를 열어 브라우저로 확인한다 (바가 8줄 모두 보이는지, 치수선이 맞는지). 끝나면 서버를 끈다.

### 6. 올리기
운영 서버에는 **실제 작업지시가 생기고 작업장에 알림이 간다.** 올리기 전에 업체·종류·색상·바 줄 수를 요약해 한 번 더 확인받는다.
절단서는 JSON 파일로 만든다 (`blender_scan` 결과의 `items` 에서 `bar_name`, `length_mm`, `qty` 만 있으면 된다):

```
python scripts/upload_order.py new --html <파일>.html --company "<업체>" --kind make --color <색상> --items items.json --delete-glb <파일>.glb
```
- `--delete-glb` 는 업로드가 **성공한 뒤에만** 중간 재료인 `.glb` 를 지운다. 서버와 브라우저 보기(HTML 더블클릭)에는 glb 가 필요 없고, 모델은 HTML 안에 들어 있다. 실패하면 glb 를 남겨 두어 다시 시도할 수 있다. 바탕화면 `model` 폴더에는 도면 `.html` 만 남는다.
- 새 작업지시는 **한 번만 시도한다.** 전송 중 연결이 끊기면 서버가 이미 받았을 수 있어 자동 재시도하면 같은 작업이 두 번 접수된다. 끊기면 앱에서 작업이 생겼는지 확인한 뒤에만 다시 올린다.
- 결과에서 작업 번호, 예상 무게, **미등록 바 경고**를 읽어 사용자에게 알린다.

이미 올라간 작업의 도면만 바꿀 때 (뷰어 개선 반영 등):
```
python scripts/upload_order.py replace --order <작업번호> --html <파일>.html [--delete-glb <파일>.glb]
```
같은 도면을 덮어쓰는 것이라 실패하면 자동으로 3번까지 다시 보낸다. 뷰어를 고친 뒤 HTML 을 다시 만들 때는 glb 가 필요하므로, 그때는 Blender 에서 다시 내보낸다(`.blend` 가 저장되어 있으면 된다).

## 알아 둘 규칙과 이유

- **바 이름은 설정의 바(자재) 목록과 글자까지 같아야** 예상 무게가 계산된다. 예: Blender 의 `SC19` 와 설정의 `SC-19` 는 다른 바다. 맞지 않으면 "미등록 바" 표시가 붙고 그 줄의 무게는 0으로 계산된다. 올린 뒤 경고가 나오면 설정의 이름을 맞추거나(권장), 앱의 "내용 수정"에서 이름을 골라 저장하면 다시 계산된다.
- 바 이름 규칙: 오브젝트 이름의 첫 `_` 앞이 바 종류다(`NS112SL104_Left` → `NS112SL104`). 치수선은 재질 이름이 `DIM...` 이거나 이름이 `D112_...` 처럼 `D숫자_` 로 시작하는 것. 이 규칙이 다른 모델은 `blender_scan.py` 와 뷰어의 묶는 규칙을 함께 손봐야 한다.
- 제작 작업은 색상 하나만 받는다. 절단 작업은 서버가 색상별로 나누지만 이 스킬은 한 번에 색 하나만 올린다.
- Windows PowerShell 5.1 에서는 `&&` 를 쓸 수 없고, JSON 파일은 BOM 이 붙을 수 있다(코드가 처리함). 한글이 들어가는 값은 가급적 파일로 넘기고, 결과에 글자가 깨져 보이면 화면 인코딩 문제인지 먼저 확인한다.
- 접속 키·PIN 은 출력하거나 파일에 새로 적지 않는다.

더 자세한 서버 규칙·뷰어 기능·문제 해결은 `references/server-and-viewer.md` 를 읽는다.
