-- 직원(사용자)별 메일 설정. 거래 내용을 메일로 보낼 때 이 직원이 쓰는 메일 서비스의 작성 페이지를 열어 준다.
-- mail_service: gmail / outlook / naver / daum / app(기본 메일 앱) 중 하나, NULL 은 아직 고르지 않음
-- mail_address: 직원 본인의 메일 주소(선택). Gmail 에서 여러 계정이 로그인되어 있어도 이 계정으로 작성 창을 열기 위해 쓴다.
ALTER TABLE users ADD COLUMN mail_service TEXT;
ALTER TABLE users ADD COLUMN mail_address TEXT;
