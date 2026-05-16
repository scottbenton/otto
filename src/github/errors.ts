export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitHubError";
  }
}

export class AuthError extends GitHubError {
  constructor(message: string, statusCode: number) {
    super(message, statusCode);
    this.name = "AuthError";
  }
}

export class NotFoundError extends GitHubError {
  constructor(message: string) {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

export class RateLimitError extends GitHubError {
  constructor(
    message: string,
    statusCode: number,
    public readonly resetAt: Date,
  ) {
    super(message, statusCode);
    this.name = "RateLimitError";
  }
}

export class SecondaryRateLimitError extends GitHubError {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number,
  ) {
    super(message, 403);
    this.name = "SecondaryRateLimitError";
  }
}

export class NetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NetworkError";
  }
}
