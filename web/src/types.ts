export type Role = 'admin' | 'staff' | 'workshop';
export type Status = 'pending' | 'making' | 'unpaid' | 'paid';
export type Kind = 'cut' | 'make';

export const COLORS = ['화이트', '블랙', '실버', '헨켈'] as const;
export type Color = (typeof COLORS)[number];

export interface User {
  id: number;
  name: string;
  role: Role;
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
