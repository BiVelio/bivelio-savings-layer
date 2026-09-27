/**
 * Rejection of `SavingsStream.result` when the stream was aborted before the
 * provider finished its answer. Nothing was cached and no usage was recorded.
 */
export class StreamAbortedError extends Error {
  /**
   * True when a request had already been sent to the provider: the provider may
   * bill the tokens it generated before the cancel, and that cost is in no report.
   */
  readonly requestSent: boolean;
  constructor(requestSent: boolean) {
    super(
      requestSent
        ? "[bvsala] stream aborted: the provider request was cancelled before its final usage; nothing was cached or recorded"
        : "[bvsala] stream aborted before any provider request was sent",
    );
    this.name = "StreamAbortedError";
    this.requestSent = requestSent;
  }
}

/**
 * Thrown by `layer.batches.submit()` when a chunk fails after earlier chunks were
 * already created at the provider. Those batches run and are billed: keep `job` and
 * read it with `results()`, or pass it to `cancel()`.
 */
export class BatchSubmitError extends Error {
  /** The batches that were created, as a job you can read or cancel. `batchIds` may be empty. */
  readonly job: import("../contracts/batch.js").BatchJob;
  /** Your ids of the requests that were not sent. */
  readonly notSubmitted: string[];
  constructor(
    message: string,
    job: import("../contracts/batch.js").BatchJob,
    notSubmitted: string[],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BatchSubmitError";
    this.job = job;
    this.notSubmitted = notSubmitted;
  }
}
