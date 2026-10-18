/** A household rule refused the request; the message is safe to show. */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
