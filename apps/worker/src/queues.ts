export const QUEUES = {
  FOLLOW_UP: "follow-up",
  ORDER_PROGRESS: "order-progress",
  ORDER_EXPIRY: "order-expiry",
  ABANDONED_CART: "abandoned-cart",
  REPEAT_PURCHASE_SCAN: "repeat-purchase-scan",
  UNANSWERED_CONVERSATION_SCAN: "unanswered-conversation-scan",
  CUSTOMER_HEALTH_SCAN: "customer-health-scan",
} as const;

export interface FollowUpJobData {
  conversationId: string;
  businessId: string;
  customerId: string;
}

export interface OrderProgressJobData {
  orderId: string;
  businessId: string;
  nextStatus: "PAID";
}

export interface FulfillmentProgressJobData {
  orderId: string;
  businessId: string;
  nextStage: "PACKED" | "SHIPPED" | "OUT_FOR_DELIVERY" | "DELIVERED";
}

export type OrderProgressQueueJob = OrderProgressJobData | FulfillmentProgressJobData;

export interface OrderExpiryJobData {
  orderId: string;
  businessId: string;
  // the status the order was in when this expiry was scheduled — only acts if it's still in that exact status,
  // so approving/paying an order harmlessly outdates any expiry job scheduled for its earlier state
  expectedStatus: "AWAITING_APPROVAL" | "PENDING_PAYMENT";
}

export interface AbandonedCartJobData {
  cartId: string;
  businessId: string;
  customerId: string;
}

// no meaningful payload — a scheduled/repeatable job that scans every opted-in business each run
export type RepeatPurchaseScanJobData = Record<string, never>;
export type UnansweredConversationScanJobData = Record<string, never>;
export type CustomerHealthScanJobData = Record<string, never>;
