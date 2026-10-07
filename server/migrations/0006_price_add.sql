-- 추가 단가(원/kg). 같은 색이라도 자재 값이 더 비싼 바(예: 방범창 4023 상/하단바·중간바)를 쓰면 kg당 단가에 더한다.
--  bar_database.price_add : 그 바의 추가 단가 (설정 > 바 목록에서 입력, 기본 0)
--  orders.price_add       : 작업이 만들어질 때(또는 절단서를 고칠 때) 들어 있는 바 중 가장 큰 추가 단가를 고정해 둔 값.
--                           바의 추가 단가를 나중에 바꿔도 이미 접수된 작업은 그대로다. 금액은 저장하지 않고
--                           (색상 단가 + orders.price_add) × 실제 무게로 조회할 때 계산한다. 변경 이력은 두지 않는다.
ALTER TABLE bar_database ADD COLUMN price_add INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN price_add INTEGER NOT NULL DEFAULT 0;
