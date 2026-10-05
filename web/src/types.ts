export type Role = 'admin' | 'staff' | 'workshop';
export type Status = 'pending' | 'making' | 'unpaid' | 'paid';
export type Kind = 'cut' | 'make';

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

export interface OrderSummary {
  id: number;
  company: string;
  kind: Kind;
  status: Status;
  source: 'front' | 'blender' | 'manual';
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
  color: string;
  theory_weight?: number;
}

export interface OrderDetail extends OrderSummary {
  content: string;
  request_note: string;
  items: OrderItem[];
}

export const KIND_LABEL: Record<Kind, string> = { cut: '절단만', make: '제작(절단 포함)' };
export const STATUS_LABEL: Record<Status, string> = {
  pending: '대기',
  making: '제작중',
  unpaid: '미납',
  paid: '완납',
};
