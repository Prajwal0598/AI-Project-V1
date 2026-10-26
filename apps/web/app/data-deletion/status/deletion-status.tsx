"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getMetaDeletionStatus } from "../../../lib/api";
import type { MetaDeletionStatusView } from "../../../lib/api";
import { LEGAL_CONTACT_EMAIL } from "../../../components/legal-page";

const CODE_PATTERN = /^[a-f0-9]{32}$/;

type State = { kind: "loading" } | { kind: "unknown" } | { kind: "error" } | { kind: "ready"; view: MetaDeletionStatusView };

const STATUS_LABELS: Record<string, string> = {
  PENDING_REVIEW: "Received — under manual review",
  COMPLETED: "Completed",
  NO_DATA_HELD: "Completed — no data held",
};

function fmt(iso: string | null) {
  return iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}

export function DeletionStatus() {
  const code = useSearchParams().get("code")?.trim() ?? "";
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    if (!CODE_PATTERN.test(code)) { setState({ kind: "unknown" }); return; }
    let cancelled = false;
    getMetaDeletionStatus(code)
      .then(view => { if (!cancelled) setState(view ? { kind: "ready", view } : { kind: "unknown" }); })
      .catch(() => { if (!cancelled) setState({ kind: "error" }); });
    return () => { cancelled = true; };
  }, [code]);

  if (state.kind === "loading") return <p>Checking your request…</p>;
  if (state.kind === "error") return <p>We could not load the status of your request right now. Please try again shortly, or contact <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} style={{ color: "var(--purple)" }}>{LEGAL_CONTACT_EMAIL}</a>.</p>;
  if (state.kind === "unknown") {
    return <p>We could not find a data deletion request for this confirmation code. Check that you copied the whole link, or contact <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} style={{ color: "var(--purple)" }}>{LEGAL_CONTACT_EMAIL}</a> with your confirmation code.</p>;
  }

  const { view } = state;
  return (
    <>
      <p><strong>Status:</strong> {STATUS_LABELS[view.status] ?? "In progress"}</p>
      <p>{view.message}</p>
      <p><strong>Confirmation code:</strong> <code>{view.confirmationCode}</code></p>
      <p><strong>Received:</strong> {fmt(view.receivedAt)}</p>
      {view.completedAt && <p><strong>Completed:</strong> {fmt(view.completedAt)}</p>}
      <p>Questions? Contact <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} style={{ color: "var(--purple)" }}>{LEGAL_CONTACT_EMAIL}</a> and quote the confirmation code above. For general deletion instructions see <a href="/data-deletion" style={{ color: "var(--purple)" }}>Data Deletion</a>.</p>
    </>
  );
}
