export type Role = 'admin' | 'staff' | 'workshop';
export type Status = 'pending' | 'making' | 'unpaid' | 'paid';
export type Kind = 'cut' | 'make';

export const COLORS = ['화이트', '블랙', '실버', '헨켈', '기타'] as const;
export type Color = (typeof COLORS)[number];

/** 메일 서비스: 거래 내용을 보낼 때 이 서비스의 메일 작성 페이지를 연다 */
export type MailService = 'gmail' | 'outlook' | 'naver' | 'daum' | 'app';
export const MAIL_SERVICES: { key: MailService; label: string; hint: string }[] = [
  { key: 'gmail', label: 'Gmail', hint: '받는 사람·제목·내용이 채워진 작성 창이 열립니다' },
  { key: 'outlook', label: 'Outlook (웹)', hint: '받는 사람·제목·내용이 채워진 작성 창이 열립니다' },
  { key: 'naver', label: '네이버 메일', hint: '작성 창을 열고 내용을 복사해 둡니다 (붙여넣기 필요할 수 있음)' },
  { key: 'daum', label: '다음 메일', hint: '작성 창을 열고 내용을 복사해 둡니다 (붙여넣기 필요)' },
  { key: 'app', label: '기본 메일 앱', hint: '컴퓨터·폰에 설정된 메일 프로그램이 열립니다' },
];

export interface User {
  id: number;
  name: string;
  role: Role;
  mail_service?: MailService | null;
  mail_address?: string | null;
}

export interface Bar {
  id: number;
  name: string;
  kg_per_m: number;
  note: string | null;
}

export interface ColorPrice {
  color: Color;
  price_per_kg: number | null;
  effective_from: string | null;
}

export interface OrderSummary {
  id: number;
  company: string;
  kind: Kind;
  status: Status;
  source: 'front' | 'blender' | 'manual';
  color: Color | null;
  group_id: number | null;
  has_unknown_bar: number;
  theory_weight: number;
  actual_weight: number | null;
  has_drawing: number;
  created_at: string;
  completed_at: string | null;
  paid_at: string | null;
}

export interface OrderItem {
  id?: number;
  bar_name: string;
  length_mm: number;
  qty: number;
  color: Color;
  theory_weight?: number;
}

export interface OrderDetail extends OrderSummary {
  request_note: string;
  items: OrderItem[];
  /** 제작비용(원). null 은 아직 입력하지 않음. 제작 작업에만 쓴다 (작업장에는 내려오지 않는다) */
  make_cost?: number | null;
  price_per_kg?: number | null;
  amount?: number | null;
}

export interface Company {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  order_count: number;
}

export const KIND_LABEL: Record<Kind, string> = { cut: '절단', make: '제작' };
export const STATUS_LABEL: Record<Status, string> = {
  pending: '대기',
  making: '제작중',
  unpaid: '미납',
  paid: '완납',
};
