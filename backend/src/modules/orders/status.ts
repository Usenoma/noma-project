export type OrderStatus =
  | "created"
  | "awaiting_payment"
  | "paid"
  | "fulfilling"
  | "delivered"
  | "expired"
  | "failed"
  | "refunding"
  | "refunded";

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  created: ["awaiting_payment"],
  awaiting_payment: ["paid", "expired"],
  paid: ["fulfilling"],
  fulfilling: ["delivered", "failed"],
  delivered: [],
  expired: ["refunding"], // paid after expiry: the late payment is refunded
  failed: ["refunding"],
  refunding: ["refunded"],
  refunded: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedFrom(to: OrderStatus): OrderStatus[] {
  return (Object.keys(TRANSITIONS) as OrderStatus[]).filter((from) => canTransition(from, to));
}
