export type ErrorCode =
  | "quota_exceeded"
  | "upload_limit_exceeded"
  | "rate_limited"
  | "auth_expired"
  | "not_connected"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "channel_not_verified"
  | "file_error"
  | "network"
  | "server_error"
  | "session_expired"
  | "cancelled"
  | "not_configured"
  | "unknown";

export class YtError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly opts: {
      retryable?: boolean;
      hint?: string;
      status?: number;
      reason?: string;
    } = {},
  ) {
    super(message);
    this.name = "YtError";
  }
  get retryable() {
    return this.opts.retryable ?? false;
  }
  get hint() {
    return this.opts.hint;
  }
}

const QUOTA_HINT =
  "Stopped instead of retrying. YouTube quota resets at midnight Pacific Time. Check quota_status, then resume_upload after the reset.";

interface GoogleErrorShape {
  code?: number | string;
  status?: number;
  message?: string;
  errors?: { reason?: string; message?: string }[];
  response?: {
    status?: number;
    data?: {
      error?:
        | string
        | {
            code?: number;
            message?: string;
            errors?: { reason?: string; message?: string }[];
          };
      error_description?: string;
    };
  };
  cause?: unknown;
}

/** Turn a googleapis / gaxios / fetch error (or a parsed JSON error body) into a YtError. */
export function classifyGoogleError(err: unknown, context = "YouTube request"): YtError {
  if (err instanceof YtError) return err;
  const e = (err ?? {}) as GoogleErrorShape;
  const data = e.response?.data;
  const status =
    e.response?.status ?? e.status ?? (typeof e.code === "number" ? e.code : undefined);
  const apiErr = typeof data?.error === "object" ? data.error : undefined;
  const reasons = (apiErr?.errors ?? e.errors ?? []).map((x) => x.reason ?? "");
  const reason = reasons[0] ?? "";
  const message = apiErr?.message ?? e.message ?? String(err);

  if (data?.error === "invalid_grant" || /invalid_grant/.test(message)) {
    return new YtError(
      "auth_expired",
      "The Google sign-in for this channel has expired or was revoked.",
      {
        hint: "Run connect_channel to sign in again. (While the OAuth consent screen is in Testing mode, Google expires refresh tokens after 7 days.)",
        status,
        reason: "invalid_grant",
      },
    );
  }
  if (reasons.some((r) => r === "quotaExceeded" || r === "dailyLimitExceeded")) {
    return new YtError("quota_exceeded", `YouTube API quota exhausted (${context}).`, {
      hint: QUOTA_HINT,
      status,
      reason,
    });
  }
  if (reasons.includes("uploadLimitExceeded")) {
    return new YtError(
      "upload_limit_exceeded",
      "This channel or project hit its YouTube upload limit for today.",
      {
        hint: QUOTA_HINT,
        status,
        reason,
      },
    );
  }
  if (
    reasons.some((r) => r === "rateLimitExceeded" || r === "userRateLimitExceeded") ||
    status === 429
  ) {
    return new YtError("rate_limited", "YouTube is rate limiting requests right now.", {
      retryable: true,
      status,
      reason,
    });
  }
  if (status === 401) {
    return new YtError("auth_expired", "Google rejected the access token.", {
      retryable: true,
      status,
      reason,
      hint: "Reconnect the channel if this repeats.",
    });
  }
  if (status === 403) {
    if (
      /thumbnail/i.test(message) ||
      /verif/i.test(message) ||
      (reason === "forbidden" && /custom/i.test(message))
    ) {
      return new YtError("channel_not_verified", message, {
        status,
        reason,
        hint: "Custom thumbnails and videos longer than 15 minutes need a phone-verified channel: https://www.youtube.com/verify",
      });
    }
    if (reason === "youtubeSignupRequired") {
      return new YtError("forbidden", "This Google account has no YouTube channel yet.", {
        status,
        reason,
        hint: "Create the channel at https://www.youtube.com/create_channel, then connect again.",
      });
    }
    return new YtError("forbidden", message, { status, reason });
  }
  if (status === 404) return new YtError("not_found", message, { status, reason });
  if (status === 400) return new YtError("invalid_request", message, { status, reason });
  if (status && status >= 500)
    return new YtError("server_error", message, {
      retryable: true,
      status,
      reason,
    });
  const code = (e.code ?? (e.cause as { code?: string } | undefined)?.code) as string | undefined;
  if (
    code &&
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|UND_ERR/.test(String(code))
  ) {
    return new YtError("network", `Network error: ${message}`, {
      retryable: true,
    });
  }
  if (err instanceof TypeError && /fetch failed|network/i.test(message)) {
    return new YtError("network", `Network error: ${message}`, {
      retryable: true,
    });
  }
  return new YtError("unknown", message, { status, reason });
}

/** Parse a YouTube JSON error body from a raw fetch Response. */
export async function errorFromResponse(res: Response, context: string): Promise<YtError> {
  let data: unknown = undefined;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  return classifyGoogleError(
    {
      response: { status: res.status, data: data as never },
      message: `${context} failed with HTTP ${res.status}`,
    },
    context,
  );
}
