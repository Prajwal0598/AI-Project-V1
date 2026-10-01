"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, getToken, setToken, setRefreshToken } from "../../lib/api";

// shared by the inline showcase panel and the "See how Relay works" modal, so the demo content never drifts between the two
function DemoChat() {
  return (
    <div className="login-mock-chat">
      <div className="login-mock-header">
        <div className="login-mock-avatar">B</div>
        <div><strong>Your Business</strong><small><i />Online</small></div>
      </div>
      <div className="login-mock-body">
        <div className="login-mock-bubble inbound">Hi, I&apos;m looking for a black dress under ₹3,000</div>
        <div className="login-mock-bubble outbound">Here are some beautiful options under ₹3,000 👗</div>
        <div className="login-mock-products">
          <div className="login-mock-product"><span>Black Midi Dress</span><b>₹2,499</b></div>
          <div className="login-mock-product"><span>Classic Black Dress</span><b>₹2,799</b></div>
          <div className="login-mock-product"><span>Elegant Wrap Dress</span><b>₹2,999</b></div>
        </div>
        <div className="login-mock-bubble inbound">I&apos;ll take the first one.</div>
        <div className="login-mock-bubble outbound">Perfect! Here&apos;s your order summary.</div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showDemo, setShowDemo] = useState(false);

  useEffect(() => {
    if (getToken()) router.replace("/");
  }, [router]);

  useEffect(() => {
    if (!showDemo) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") setShowDemo(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showDemo]);

  async function submit() {
    setError("");
    setLoading(true);
    try {
      const { accessToken, refreshToken } = mode === "login"
        ? await api.auth.login(email.trim(), password)
        : await api.auth.register(email.trim(), password, name.trim(), businessName.trim());
      setToken(accessToken);
      setRefreshToken(refreshToken);
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-showcase">
        <div className="login-showcase-glow" />
        <div className="login-showcase-top">
          <div className="login-brand"><span>r</span>relay</div>
          <span className="login-showcase-tag">AI-Powered Commerce</span>
        </div>

        <h1 className="login-showcase-headline">Turn conversations into <em>customers</em>.</h1>
        <p className="login-showcase-copy">
          Relay helps businesses turn customer conversations into sales — with AI that answers questions,
          recommends products, takes orders and follows up automatically.
        </p>
        <button type="button" className="login-demo-cta" onClick={() => setShowDemo(true)}>See how Relay works →</button>

        <div className="login-showcase-features">
          <div><span className="login-feature-icon peach">💬</span>AI Sales Assistant</div>
          <div><span className="login-feature-icon purple">🛍</span>Product Recommendations</div>
          <div><span className="login-feature-icon blue">💳</span>Automated Orders &amp; Payments</div>
          <div><span className="login-feature-icon yellow">📈</span>Follow-ups that Convert</div>
        </div>

        <div className="login-showcase-demo">
          <DemoChat />
          <div className="login-mock-callouts">
            <div className="login-callout"><span>🔍</span><div><strong>Finds leads</strong><small>Across WhatsApp, Instagram &amp; Facebook</small></div></div>
            <div className="login-callout"><span>✨</span><div><strong>Recommends products</strong><small>Matched to what customers ask for</small></div></div>
            <div className="login-callout"><span>💳</span><div><strong>Takes orders &amp; payments</strong><small>Cash on delivery or instant UPI</small></div></div>
            <div className="login-callout"><span>📈</span><div><strong>Follows up automatically</strong><small>Recovers carts, nudges repeat buyers</small></div></div>
          </div>
        </div>

        <div className="login-showcase-trust">
          <div><span>🔒</span>Secure &amp; reliable</div>
          <div><span>🤝</span>Trusted by businesses</div>
          <div><span>⚡</span>Get started quickly</div>
        </div>
      </div>

      <div className="login-panel">
        <div className="login-card">
          <h1>{mode === "login" ? "Welcome back" : "Create your account"} {mode === "login" && <span className="login-wave">👋</span>}</h1>
          <p>{mode === "login" ? "Sign in to your Relay workspace." : "Set up your AI sales workspace."}</p>

          {error && <div className="login-error">{error}</div>}

          {mode === "register" && (
            <>
              <div className="login-field">
                <label>Your name</label>
                <input type="text" placeholder="Prajwal" value={name} onChange={e => setName(e.target.value)} />
              </div>
              <div className="login-field">
                <label>Business name</label>
                <input type="text" placeholder="Acme Store" value={businessName} onChange={e => setBusinessName(e.target.value)} />
              </div>
            </>
          )}

          <div className="login-field">
            <label>Email</label>
            <input type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()} />
          </div>
          <div className="login-field">
            <label>Password</label>
            <input type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()} />
          </div>

          <button className="primary-button login-submit" onClick={submit} disabled={loading}>
            {loading ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>

          <p className="login-toggle">
            {mode === "login" ? "New to Relay?" : "Already have an account?"}
            <button onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>
              {mode === "login" ? "Start selling with Relay →" : "Sign in"}
            </button>
          </p>
          <p style={{ marginTop: 24, fontSize: 11, color: "var(--muted)", display: "flex", gap: 12, justifyContent: "center" }}>
            <Link href="/privacy" style={{ color: "var(--muted)" }}>Privacy</Link>
            <Link href="/terms" style={{ color: "var(--muted)" }}>Terms</Link>
            <Link href="/cookies" style={{ color: "var(--muted)" }}>Cookies</Link>
            <Link href="/data-deletion" style={{ color: "var(--muted)" }}>Data Deletion</Link>
          </p>
        </div>
      </div>

      {showDemo && (
        <div className="login-demo-backdrop" role="presentation" onClick={() => setShowDemo(false)}>
          <div className="login-demo-modal" role="dialog" aria-modal="true" aria-label="Relay product demo" onClick={e => e.stopPropagation()}>
            <button type="button" className="login-demo-close" aria-label="Close demo" onClick={() => setShowDemo(false)}>✕</button>
            <h2>See how Relay works</h2>
            <p>A real conversation, handled automatically from question to order.</p>
            <DemoChat />
          </div>
        </div>
      )}
    </div>
  );
}
