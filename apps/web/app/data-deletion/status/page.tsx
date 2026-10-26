import { Suspense } from "react";
import { LegalPage } from "../../../components/legal-page";
import { DeletionStatus } from "./deletion-status";

// the page Meta's Data Deletion callback points people to; keyed by an unguessable confirmation code, so keep it out of search results
export const metadata = { title: "Data Deletion Request Status — RelayShift", robots: { index: false, follow: false } };

export default function DataDeletionStatusPage() {
  return (
    <LegalPage title="Data Deletion Request Status" showLastUpdated={false}>
      <Suspense fallback={<p>Checking your request…</p>}>
        <DeletionStatus />
      </Suspense>
    </LegalPage>
  );
}
