"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, getToken, setToken } from "../../lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (getToken()) router.replace("/");
  }, [router]);

  async function submit() {
    setError("");
    setLoading(true);
    try {
      const { accessToken } = mode === "login"
        ? await api.auth.login(email.trim(), password)
        : await api.auth.register(email.trim(), password, name.trim(), businessName.trim());
      setToken(accessToken);
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand"><span>r</span>relay</div>
        <h1>{mode === "login" ? "Welcome back" : "Create your account"}</h1>
        <p>{mode === "login" ? "Sign in to your workspace." : "Set up your AI sales workspace."}</p>

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
          {mode === "login" ? "Don't have an account?" : "Already have an account?"}
          <button onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>
            {mode === "login" ? "Sign up" : "Sign in"}
          </button>
        </p>
      </div>
    </div>
  );
}
