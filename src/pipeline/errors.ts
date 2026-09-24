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
