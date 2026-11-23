// Errors the API layer maps to HTTP responses. `message` is safe to show players.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** A daily cap was hit (global Muse spend cap or per-couple draft cap). */
export class LimitError extends HttpError {
  constructor(message) {
    super(429, message);
    this.name = "LimitError";
  }
}
