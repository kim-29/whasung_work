-- 제작비용(인건비+부속비를 합친 한 칸, 원). NULL 은 '아직 입력하지 않음', 0 은 '0원으로 입력함'. 제작 작업에만 쓴다.
ALTER TABLE orders ADD COLUMN make_cost INTEGER;

-- 업체 정보. 오더의 company 는 이 표의 name 과 같은 글자로 이어진다(이름 변경·합치기는 서버가 함께 처리).
CREATE TABLE companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  phone TEXT,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 지금까지 접수된 업체명을 모두 등록해 둔다
INSERT OR IGNORE INTO companies (name) SELECT DISTINCT company FROM orders;
