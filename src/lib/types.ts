import type { Mode, PackageSize } from "./locations";
import type { PaymentStatus, PendingAction } from "./escrow/state";

export interface Profile {
  id: string;
  auth_user_id: string | null;
  is_demo: boolean;
  is_resolver: boolean;
  display_name: string;
  campus: string;
  campus_email: string | null;
  campus_email_verified_at: Date | null;
  home_zone: string;
  transport: Mode;
  capacity: PackageSize;
  min_fee_units: number;
  max_detour_min: number;
  default_budget_units: number;
  default_deadline_buffer_min: number;
  availability: { day: string; start: string; end: string }[];
  payout_address: string | null;
  onboarded: boolean;
  created_at: Date;
}

export interface Trip {
  id: string;
  worker_id: string;
  origin_zone: string;
  store_id: string;
  return_zone: string;
  depart_at: Date;
  return_by: Date;
  transport: Mode;
  capacity: PackageSize;
  notes: string | null;
  auto_accept: boolean;
  status: "planned" | "cancelled" | "completed";
  created_at: Date;
}

export type TaskStatus = "open" | "negotiating" | "agreed" | "picked_up" | "handed_off" | "completed" | "cancelled" | "disputed";

export interface Task {
  id: string;
  requester_id: string;
  store_id: string;
  delivery_zone: string;
  delivery_detail: string | null;
  order_reference: string | null;
  pickup_window_start: Date;
  pickup_window_end: Date;
  delivery_deadline: Date;
  package_size: PackageSize;
  prepaid_confirmed: boolean;
  offered_fee_units: number;
  max_fee_units: number;
  instructions: string | null;
  raw_text: string | null;
  status: TaskStatus;
  terms_version: number;
  fund_authorized_units: number | null;
  completed_at: Date | null;
  created_at: Date;
}

export interface Offer {
  id: string;
  task_id: string;
  worker_id: string;
  trip_id: string;
  task_terms_version: number;
  decision: "accept" | "counter" | "reject";
  fee_units: number;
  effort_low_min: number;
  effort_high_min: number;
  trip_total_min: number;
  eta_delivery: Date | null;
  score: number | null;
  factors: { notes?: string[]; assumptions?: string[]; total?: number; withinBudget?: boolean; baselineTripMin?: number; tripTotalLowMin?: number };
  summary: string;
  agent_source: "llm" | "rules";
  transcript: import("./agents/negotiation").Turn[];
  status: "proposed" | "selected" | "declined" | "expired" | "superseded";
  expires_at: Date;
  created_at: Date;
}

export interface Agreement {
  id: string;
  task_id: string;
  offer_id: string;
  requester_id: string;
  worker_id: string;
  trip_id: string;
  current_version: number;
  status: "pending" | "approved" | "cancelled";
  created_at: Date;
}

export interface Payment {
  id: string;
  task_id: string;
  agreement_id: string;
  mode: "simulated" | "arc_testnet";
  amount_units: number;
  status: PaymentStatus;
  resolved_by_resolver: boolean;
  pending_action: PendingAction | null;
  pending_tx: string | null;
  pending_since: Date | null;
  escrow_id: string;
  chain_id: number | null;
  contract_address: string | null;
  payer_address: string | null;
  worker_address: string | null;
  fund_tx: string | null;
  release_tx: string | null;
  refund_tx: string | null;
  refund_after: Date | null;
  refund_reason: "requester_cancel" | "worker_cancel" | "deadline" | "dispute" | null;
  release_due_at: Date | null;
  updated_at: Date;
}

export interface Reputation {
  profile_id: string;
  completed_as_worker: number;
  on_time_deliveries: number;
  completed_as_requester: number;
  cancellations_after_acceptance: number;
  avg_confirm_minutes: number | null;
  worker_review_count: number;
  worker_avg_rating: number | null;
  requester_review_count: number;
  requester_avg_rating: number | null;
}
