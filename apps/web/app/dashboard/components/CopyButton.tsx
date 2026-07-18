"use client";

import { useState } from "react";

/** Tiny client island: copy a snippet to the clipboard with feedback. */
export function CopyButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className="copybtn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setOk(true);
          setTimeout(() => setOk(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {ok ? "Copied" : "Copy"}
    </button>
  );
}
