export const QUEUES = {
  FOLLOW_UP: "follow-up",
  ORDER_PROGRESS: "order-progress",
} as const;

export interface FollowUpJobData {
  conversationId: string;
  businessId: string;
  customerId: string;
}

export interface OrderProgressJobData {
  orderId: string;
  businessId: string;
  nextStatus: "PAID" | "FULFILLED";
}
