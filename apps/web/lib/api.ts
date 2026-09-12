const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";
const TOKEN_KEY = "relay_token";

// product images are stored as a relative path (e.g. "/api/uploads/products/x.jpg") so this dashboard can
// always reach them via the local API origin, independent of whatever public URL WhatsApp needs to fetch them from
export function resolveImageUrl(imageUrl: string | null): string | null {
  if (!imageUrl) return null;
  if (/^https?:\/\//i.test(imageUrl)) return imageUrl;
  return `${API_URL.replace(/\/api$/, "")}${imageUrl}`;
}

// ─── Token helpers ────────────────────────────────────────────────────────────

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// Decode businessId from JWT payload without verifying signature (client-side use only)
export function getBusinessId(): string | null {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!)) as { businessId?: string };
    return payload.businessId ?? null;
  } catch {
    return null;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Message {
  id: string;
  conversationId: string;
  direction: "INBOUND" | "OUTBOUND" | "SYSTEM";
  content: string;
  sentAt: string;
  metadata: Record<string, unknown> | null;
}

export interface ConversationSummary {
  id: string;
  channel: string;
  status: string;
  lastMessageAt: string | null;
  escalated: boolean;
  escalationReason: string | null;
  outcome: "OPEN" | "SALE" | "SUPPORT" | "ESCALATED" | "LOST" | "ABANDONED";
  customer: { id: string; firstName: string | null; lastName: string | null; phone: string | null };
  identity: { identifier: string; displayName: string | null } | null;
  messages: Message[];
}

export interface ConversationDetail extends ConversationSummary {
  customer: ConversationSummary["customer"] & { email: string | null };
  messages: Message[];
}

export interface ActivityEvent {
  id: string;
  type: "CONVERSATION_CREATED" | "MESSAGE_SENT" | "ORDER_PLACED" | "ORDER_UPDATED" | "CUSTOMER_TAGGED" | "LEAD_SCORED";
  summary: string;
  createdAt: string;
  customer: { id: string; firstName: string | null; lastName: string | null; phone: string | null } | null;
}

export interface Business {
  id: string;
  name: string;
  industry: string | null;
  website: string | null;
  timezone: string;
  whatsappPhoneNumberId: string | null;
  instagramPageId: string | null;
  supportEmail: string | null;
  autonomyMaxOrderValue: string | null;
  whatsappAccessTokenConfigured: boolean;
  instagramAccessTokenConfigured: boolean;
  postmarkServerTokenConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessStats {
  leads: number;
  customers: number;
  conversations: number;
  openConversations: number;
  orders: number;
  revenue: string | number;
  revenueThisWeek: string | number;
  revenueLastWeek: string | number;
  revenueSeries: { thisWeek: number[]; lastWeek: number[] };
}

export interface Order {
  id: string;
  customerId: string;
  status: "DRAFT" | "AWAITING_APPROVAL" | "PENDING_PAYMENT" | "PAID" | "FULFILLED" | "CANCELLED" | "REFUNDED";
  fulfillmentStatus: "NOT_STARTED" | "PACKED" | "SHIPPED" | "OUT_FOR_DELIVERY" | "DELIVERED" | "FAILED" | "RETURNED";
  subtotal: string;
  shippingFee: string;
  total: string;
  currency: string;
  paymentMethod: string | null;
  createdAt: string;
  customer: { id: string; firstName: string | null; lastName: string | null; email: string | null };
}

export interface TeamUser {
  id: string;
  email: string;
  name: string | null;
  role: "OWNER" | "ADMIN" | "MEMBER";
  createdAt: string;
}

export interface Me {
  id: string;
  email: string;
  name: string | null;
  role: "OWNER" | "ADMIN" | "MEMBER";
  businessId: string;
}

export interface AiActionLog {
  id: string;
  customerId: string | null;
  conversationId: string | null;
  orderId: string | null;
  action: string;
  reason: string | null;
  result: string;
  createdAt: string;
}

export interface Customer {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  type: "LEAD" | "CUSTOMER";
  tags: string[];
  leadScore: { score: number; reason: string | null } | null;
  identities: { channel: string; identifier: string }[];
  _count: { conversations: number; orders: number };
  updatedAt: string;
}

export interface Variant {
  id: string;
  productId: string;
  sku: string | null;
  price: string;
  currency: string;
  inventory: number | null;
  active: boolean;
}

export type ProductStatus = "DRAFT" | "PUBLISHED" | "HIDDEN";

export interface Category {
  id: string;
  businessId: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  active: boolean;
  productCount: number;
}

export interface Product {
  id: string;
  name: string;
  description: string | null;
  category: { id: string; name: string } | null;
  brand: string | null;
  imageUrl: string | null;
  status: ProductStatus;
  source: "MANUAL" | "IMPORT";
  updatedAt: string;
  variants: Variant[];
}

export interface ImportJob {
  id: string;
  businessId: string;
  filename: string;
  sourceType: "CSV" | "XLSX";
  status: "PENDING" | "READY_FOR_REVIEW" | "COMMITTING" | "COMPLETED" | "FAILED" | "CANCELLED";
  rowsDetected: number;
  rowsReady: number;
  rowsWarning: number;
  rowsError: number;
  createdAt: string;
}

export interface ImportRow {
  id: string;
  importJobId: string;
  rowNumber: number;
  rawData: Record<string, unknown>;
  normalizedData: Record<string, unknown> | null;
  status: "READY" | "WARNING" | "ERROR";
  validationErrors: string[] | null;
  matchedProductId: string | null;
  action: "CREATE" | "UPDATE" | "SKIP" | null;
  committedProductId: string | null;
}

// ─── Core fetch wrapper ───────────────────────────────────────────────────────

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (res.status === 401) {
    clearToken();
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// like `request`, but for multipart file uploads — the browser sets its own Content-Type/boundary for FormData
async function upload<T>(path: string, formData: FormData): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    body: formData,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (res.status === 401) {
    clearToken();
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ─── API surface ──────────────────────────────────────────────────────────────

export const api = {
  auth: {
    login: (email: string, password: string) =>
      request<{ accessToken: string }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
    register: (email: string, password: string, name: string, businessName: string) =>
      request<{ accessToken: string }>("/auth/register", { method: "POST", body: JSON.stringify({ email, password, name, businessName }) }),
    me: () => request<Me>("/auth/me"),
  },
  businesses: {
    list: () => request<Business[]>("/businesses"),
    get: (id: string) => request<Business>(`/businesses/${id}`),
    update: (id: string, data: Partial<Pick<Business, "name" | "industry" | "website" | "timezone" | "whatsappPhoneNumberId" | "instagramPageId" | "supportEmail">> & { autonomyMaxOrderValue?: number | null; whatsappAccessToken?: string; instagramAccessToken?: string; postmarkServerToken?: string }) =>
      request<Business>(`/businesses/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    stats: (id: string) => request<BusinessStats>(`/businesses/${id}/stats`),
    activity: (id: string, limit = 20) => request<ActivityEvent[]>(`/businesses/${id}/activity?limit=${limit}`),
    aiActions: (id: string, limit = 50) => request<AiActionLog[]>(`/businesses/${id}/ai-actions?limit=${limit}`),
    funnel: (id: string) => request<{ conversations: number; conversationsWithOrder: number; ordersPaid: number; ordersDelivered: number }>(`/businesses/${id}/funnel`),
    revenueByChannel: (id: string) => request<Record<string, number>>(`/businesses/${id}/revenue-by-channel`),
    customerMetrics: (id: string) => request<{ payingCustomers: number; repeatPurchaseRate: number; averageOrderValue: number }>(`/businesses/${id}/customer-metrics`),
    conversationOutcomes: (id: string) => request<Record<string, number>>(`/businesses/${id}/conversation-outcomes`),
  },
  users: {
    list: (businessId: string) => request<TeamUser[]>(`/businesses/${businessId}/users`),
    create: (businessId: string, data: { email: string; password: string; name: string; role: TeamUser["role"] }) =>
      request<TeamUser>(`/businesses/${businessId}/users`, { method: "POST", body: JSON.stringify(data) }),
    updateRole: (userId: string, role: TeamUser["role"]) =>
      request<TeamUser>(`/users/${userId}/role`, { method: "PATCH", body: JSON.stringify({ role }) }),
  },
  conversations: {
    list: (businessId: string) =>
      request<ConversationSummary[]>(`/businesses/${businessId}/conversations`),
    get: (id: string) =>
      request<ConversationDetail>(`/conversations/${id}`),
    send: (id: string, content: string) =>
      request<Message>(`/conversations/${id}/send`, { method: "POST", body: JSON.stringify({ content }) }),
    aiDraft: (id: string) =>
      request<{ message: Message | null; orderCreated: { id: string; total: string; currency: string } | null }>(`/conversations/${id}/ai-draft`, { method: "POST" }),
    resume: (id: string) =>
      request<ConversationDetail>(`/conversations/${id}/resume`, { method: "POST" }),
    setOutcome: (id: string, outcome: ConversationSummary["outcome"]) =>
      request<ConversationDetail>(`/conversations/${id}/outcome`, { method: "PATCH", body: JSON.stringify({ outcome }) }),
  },
  customers: {
    list: (businessId: string, search?: string) =>
      request<Customer[]>(`/businesses/${businessId}/customers${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  },
  products: {
    list: (businessId: string) =>
      request<Product[]>(`/businesses/${businessId}/products`),
    create: (businessId: string, data: { name: string; price: number; currency?: string; inventory?: number; sku?: string; category?: string; brand?: string; status?: ProductStatus }) =>
      request<Product>(`/businesses/${businessId}/products`, { method: "POST", body: JSON.stringify(data) }),
    update: (productId: string, data: Partial<{ name: string; description: string; category: string; brand: string; status: ProductStatus }>) =>
      request<Product>(`/products/${productId}`, { method: "PATCH", body: JSON.stringify(data) }),
    updateVariant: (variantId: string, data: Partial<{ sku: string; price: number; currency: string; inventory: number; active: boolean }>) =>
      request<Variant>(`/variants/${variantId}`, { method: "PATCH", body: JSON.stringify(data) }),
    uploadImage: (productId: string, file: File) => {
      const formData = new FormData();
      formData.append("image", file);
      return upload<Product>(`/products/${productId}/image`, formData);
    },
    remove: (productId: string) =>
      request<{ id: string }>(`/products/${productId}`, { method: "DELETE" }),
    bulk: (businessId: string, data: { productIds: string[]; action: "publish" | "hide" | "draft" | "delete" | "setCategory"; category?: string }) =>
      request<{ affected: number }>(`/businesses/${businessId}/products/bulk`, { method: "PATCH", body: JSON.stringify(data) }),
  },
  categories: {
    list: (businessId: string) =>
      request<Category[]>(`/businesses/${businessId}/categories`),
    create: (businessId: string, data: { name: string; parentId?: string; sortOrder?: number }) =>
      request<Category>(`/businesses/${businessId}/categories`, { method: "POST", body: JSON.stringify(data) }),
    update: (categoryId: string, data: Partial<{ name: string; parentId: string | null; sortOrder: number; active: boolean }>) =>
      request<Category>(`/categories/${categoryId}`, { method: "PATCH", body: JSON.stringify(data) }),
    remove: (categoryId: string) =>
      request<void>(`/categories/${categoryId}`, { method: "DELETE" }),
  },
  imports: {
    list: (businessId: string) => request<ImportJob[]>(`/businesses/${businessId}/imports`),
    create: (businessId: string, file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return upload<ImportJob>(`/businesses/${businessId}/imports`, formData);
    },
    get: (id: string) => request<ImportJob>(`/imports/${id}`),
    rows: (id: string) => request<ImportRow[]>(`/imports/${id}/rows`),
    updateRow: (jobId: string, rowId: string, data: { normalizedData?: Record<string, unknown>; action?: ImportRow["action"] }) =>
      request<ImportRow>(`/imports/${jobId}/rows/${rowId}`, { method: "PATCH", body: JSON.stringify(data) }),
    commit: (id: string) => request<{ created: number; updated: number; skipped: number }>(`/imports/${id}/commit`, { method: "POST" }),
    cancel: (id: string) => request<ImportJob>(`/imports/${id}/cancel`, { method: "POST" }),
  },
  orders: {
    list: (businessId: string) => request<Order[]>(`/businesses/${businessId}/orders`),
    updateStatus: (orderId: string, status: Order["status"]) =>
      request<Order>(`/orders/${orderId}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
    approve: (orderId: string) =>
      request<Order>(`/orders/${orderId}/approve`, { method: "PATCH" }),
    updateFulfillment: (orderId: string, fulfillmentStatus: Order["fulfillmentStatus"]) =>
      request<Order>(`/orders/${orderId}/fulfillment`, { method: "PATCH", body: JSON.stringify({ fulfillmentStatus }) }),
  },
};
