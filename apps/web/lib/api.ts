const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";
const TOKEN_KEY = "relay_token";

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
  customer: { id: string; firstName: string | null; lastName: string | null; phone: string | null };
  identity: { identifier: string; displayName: string | null } | null;
  messages: Message[];
}

export interface ConversationDetail extends ConversationSummary {
  customer: ConversationSummary["customer"] & { email: string | null };
  messages: Message[];
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

export interface Product {
  id: string;
  name: string;
  description: string | null;
  price: string;
  currency: string;
  inventory: number | null;
  active: boolean;
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

// ─── API surface ──────────────────────────────────────────────────────────────

export const api = {
  auth: {
    login: (email: string, password: string) =>
      request<{ accessToken: string }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
    register: (email: string, password: string, name: string, businessName: string) =>
      request<{ accessToken: string }>("/auth/register", { method: "POST", body: JSON.stringify({ email, password, name, businessName }) }),
  },
  conversations: {
    list: (businessId: string) =>
      request<ConversationSummary[]>(`/businesses/${businessId}/conversations`),
    get: (id: string) =>
      request<ConversationDetail>(`/conversations/${id}`),
    send: (id: string, content: string) =>
      request<Message>(`/conversations/${id}/send`, { method: "POST", body: JSON.stringify({ content }) }),
    aiDraft: (id: string) =>
      request<Message>(`/conversations/${id}/ai-draft`, { method: "POST" }),
  },
  customers: {
    list: (businessId: string, search?: string) =>
      request<Customer[]>(`/businesses/${businessId}/customers${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  },
  products: {
    list: (businessId: string) =>
      request<Product[]>(`/businesses/${businessId}/products`),
    create: (businessId: string, data: { name: string; price: number; currency?: string; inventory?: number }) =>
      request<Product>(`/businesses/${businessId}/products`, { method: "POST", body: JSON.stringify(data) }),
  },
};
