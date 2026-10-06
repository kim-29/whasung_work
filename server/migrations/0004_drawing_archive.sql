-- 보관 처리한 도면 표시. 도면을 내 컴퓨터로 내려받아 확인한 뒤 서버(KV)에서 지우면 drawing_key 는 비우고
-- 언제 보관했는지만 남긴다. 앱은 이 값이 있으면 '도면 보관됨'으로 보여 준다. 도면을 다시 올리면 이 값은 지워진다.
ALTER TABLE orders ADD COLUMN drawing_archived_at TEXT;
