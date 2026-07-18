import type { Metering } from "../data";

/** The app's top-level honest state: is the SDK actually metering yet? */
export function ConnectionStatePill({ state }: { state: Metering }) {
  return state === "live" ? (
    <span className="pill live">
      <span className="dot" /> Metering live
    </span>
  ) : (
    <span className="pill await">
      <span className="dot" /> Awaiting first report
    </span>
  );
}
