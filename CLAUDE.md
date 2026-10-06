# 화성 알루미늄 주문·작업 관리 앱

알루미늄 대리점 프론트(작업지시서/대시보드/판매분석/설정)와 작업장(작업목록만)이 쓰는 앱. 화면·메시지는 모두 한국어, 사용자는 컴퓨터에 서툴 수 있으니 큰 버튼·쉬운 말 우선. 자세한 요구사항은 `docs/PRD.md`.

## 구조 (npm workspaces)
- `server/` — Cloudflare Workers + Hono + Zod. D1(`whasung-agency`), KV(도면), Durable Object `Hub`(WebSocket), Web Push.
  - `src/index.ts` 라우터 마운트 / `auth.ts` 로그인·내 메일·직원 관리 / `routes-orders.ts` 주문 / `routes-misc.ts` 바·단가·업체·대시보드·Blender ingest / `routes-analytics.ts` 판매분석 / `routes-archive.ts` 백업·보관 / `orders-service.ts` 주문 생성·색상 분리·`PRICE_SQL` / `hub.ts` 실시간 알림 / `drawings-store.ts` 도면 KV
  - `migrations/000N_*.sql` (현재 0001~0005), `test/*.test.ts` (vitest-pool-workers)
- `web/` — Vite + React + TS + Tailwind v4, TanStack Query, HashRouter, PWA. GitHub Pages 배포(push 시 Actions 빌드).
  - `src/pages/*` 화면, `mail.tsx` 업체에 메일 보내기(웹메일 작성 URL), `api.ts`(kstToday 등), `auth.tsx`, `types.ts`
- `blender/` — 도면 뷰어 템플릿(three.js, esbuild)과 `skill/whasung-blender-upload`(Blender→서버 업로드 스킬. **저장소에는 올리지 않고(.gitignore) 로컬에만 둔다**. `.skill` 패키징은 `PYTHONUTF8=1` 로 skill-creator 의 `package_skill`, 결과물은 저장소 밖 `C:\workspace\whasung-skill-package\`).

## 실행·검증
- 개발: `.claude/launch.json` 의 server(8787), web(5173) 사용. 서버 테스트 `npm test --workspace server`, 타입 `npx tsc --noEmit -p web`.
- 테스트는 DB를 공유(`isolatedStorage:false`) → 업체명·IP·연도는 테스트마다 고유하게. 느려서 `testTimeout: 30000`.
- 배포(서버): `cd server; npx wrangler d1 migrations apply whasung-agency --remote` → `npx wrangler deploy`. **마이그레이션을 먼저**, 컬럼만 추가하는 방식으로 작성(운영 데이터 보존). 프론트는 main에 push.
- 비밀값(PIN_PEPPER, 관리자 PIN, VAPID, API 키)은 Workers Secret. `.dev.vars`, `.prod-secrets.json` 은 커밋 금지.

## 업무 규칙 (바꾸면 안 되는 것)
- 금액은 저장하지 않는다: 무게 × 지시일 기준 `color_prices` 단가로 계산(첫 단가는 1970 effective_from으로 과거 전체 적용).
- 한 주문 = 한 색상. 절단 주문은 색상별로 자동 분리(`group_id`), 도면은 `drawing_key` 공유. 제작은 단일 색상.
- 상태 pending→making→unpaid→paid. `make_cost`: NULL=미입력, 0=입력됨, 제작 주문만, 완납 전까지 수정.
- 날짜 집계는 KST(+9h). 환산수량 = 길이/6m, 소수 1자리 "본".
- 업체는 마스터(자동 등록, 이름 변경/병합). 묶음 납입(pay-batch). 보관은 sha256 검증 후 KV 삭제, 완납·N개월 경과·그룹 전체만.
- 알림 `notify()` 는 실패해도 요청을 깨뜨리지 않는다(try/catch). 작업장 계정에는 금액·미납 노출 금지.
- 인증: 6자리 PIN(중복 불가), 기기 토큰(sha256 저장), IP당 5회 실패 시 15분 잠금. Blender ingest는 `X-API-Key`.
- 메일: 직원별 `mail_service`/`mail_address`(설정 > 내 메일). 웹메일 작성 URL을 열 뿐 자동 발송 안 함. 네이버·다음은 클립보드 보조(미검증).

## Windows/PowerShell 주의
- 파일은 UTF-8 **BOM 없이** 저장(BOM이 vitest/package.json을 깨뜨림). `Set-Content -Encoding utf8` 금지.
- PowerShell에서 `&&` 불가, here-string·`${}`·백틱 이스케이프 문제 → 템플릿 리터럴이 있는 TSX/TS는 Edit 도구로 수정.
- 한글 데이터 시드는 PowerShell 인자 대신 브라우저 JS/파일로(깨짐). 커밋 메시지는 `git commit -F 파일`.
- 스킬 패키징 시 `PYTHONUTF8=1`.
