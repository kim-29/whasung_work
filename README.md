# 화성 알루미늄 주문·작업 관리 앱

알루미늄 대리점(프론트)과 작업장을 잇는 주문·작업 관리 앱. 요구사항은 [docs/PRD.md](docs/PRD.md) 참고.

| 폴더 | 내용 |
|---|---|
| `server/` | Cloudflare Workers(Hono) + D1 + KV(설정·도면) + Durable Object(WebSocket) + Web Push |
| `web/` | Vite + React 프론트 (GitHub Pages 배포, PWA) |
| `blender/` | 3D 도면 뷰어 템플릿(three.js 내장 단일 HTML)과 Blender 전송 스크립트 |

## 로컬 실행

```bash
npm install
cd server && npm run db:migrate:local   # 최초 1회
```

`server/.dev.vars` 를 만들고 값을 채운다 (git 에 올라가지 않음):

```
ADMIN_PIN=숫자6자리        # 최초 관리자 로그인용
PIN_PEPPER=아무 긴 무작위 문자열
BLENDER_API_KEY=아무 긴 무작위 문자열
ALLOWED_ORIGINS=http://localhost:5173
```

```bash
npm run server:dev    # http://localhost:8787
npm run web:dev       # http://localhost:5173
npm run server:test   # 서버 테스트
```

## Cloudflare 배포 (최초 1회)

```bash
cd server
npx wrangler login
npx wrangler d1 create whasung-agency            # 출력된 database_id 를 wrangler.toml 에 기입
npx wrangler kv namespace create KV         # 출력된 id 를 wrangler.toml 에 기입
npm run db:migrate:remote
npx wrangler secret put ADMIN_PIN           # 최초 관리자 PIN(숫자 6자리)
npx wrangler secret put PIN_PEPPER
npx wrangler secret put BLENDER_API_KEY
node scripts/gen-vapid.mjs                  # 출력값으로 아래 3개 등록 (푸시 알림)
npx wrangler secret put VAPID_PUBLIC
npx wrangler secret put VAPID_PRIVATE
npx wrangler secret put VAPID_SUBJECT       # mailto:본인@이메일
```

`wrangler.toml` 의 `ALLOWED_ORIGINS` 를 GitHub Pages 주소(`https://<계정>.github.io`)로 바꾼 뒤 `npm run deploy`.

## 프론트 배포 (GitHub Pages)

1. 저장소 Settings > Pages > Source 를 **GitHub Actions** 로 설정
2. Settings > Secrets and variables > Actions > **Variables** 에 `VITE_API_URL` = Workers 주소 등록
3. `main` 에 푸시하면 자동 배포

## Blender 전송

`blender/send_order.py` 참고. 먼저 `cd blender && npm run build` 로 `dist/viewer-template.html` 을 만든 뒤,
`WHASUNG_API_URL`, `WHASUNG_API_KEY` 환경변수를 설정하고 `send_order(...)` 를 호출한다.
동작 확인: `python send_order.py --demo --out dist/demo.html` (`--send` 를 붙이면 서버로 전송).

## 첫 사용 순서

1. 관리자 PIN으로 로그인 → 설정에서 **바(자재) 목록** 등록
2. 설정 > 직원 관리에서 직원 PIN 발급, **작업장 PIN** 발급
3. 작업장 태블릿/폰에서 작업장 PIN 입력(최초 1회) → 이후 자동 로그인
