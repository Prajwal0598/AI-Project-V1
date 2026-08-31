export const QUEUES = {
  FOLLOW_UP: "follow-up",
} as const;

export interface FollowUpJobData {
  conversationId: string;
  businessId: string;
  customerId: string;
}
