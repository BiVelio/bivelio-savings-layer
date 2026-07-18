/** Provenance is stamped on every number: reference-mock vs your-org-live. */
export function ProvenancePill({ kind }: { kind: "mock" | "live" | "await" }) {
  const label = kind === "mock" ? "MOCK · reference" : kind === "live" ? "LIVE · your org" : "awaiting";
  return (
    <span className={`pill ${kind}`}>
      <span className="dot" />
      {label}
    </span>
  );
}
