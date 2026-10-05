-- 오더 하나에는 색상 하나. 한 지시서에 색상이 섞이면 색상별 오더로 나누고 group_id 로 묶는다.
ALTER TABLE orders ADD COLUMN color TEXT;
ALTER TABLE orders ADD COLUMN group_id INTEGER;
CREATE INDEX idx_orders_group ON orders(group_id);

-- 색상별 kg당 단가 이력. 단가를 바꾸면 행을 추가하고, 오더는 '지시일 이전 중 가장 최근' 단가를 쓴다.
-- 금액 자체는 저장하지 않고 조회 때마다 (실측무게 × 그때의 단가)로 계산한다.
CREATE TABLE color_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  color TEXT NOT NULL,
  price_per_kg REAL NOT NULL CHECK (price_per_kg >= 0),
  effective_from TEXT NOT NULL,
  changed_by TEXT
);
CREATE INDEX idx_color_prices ON color_prices(color, effective_from);
