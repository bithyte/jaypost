import { MAX_WAIT_SECONDS } from "@jaypost/core";
import { logPageSchema, statusInfoSchema } from "@jaypost/protocol";
import type { LogPage, StatusInfo } from "@jaypost/protocol";
import { checkAttachmentLimit, readAttachment } from "./attachment.ts";
import { FETCH_GRACE_MS } from "./constants.ts";
import {
  callApi,
  isStateBody,
  postApi,
  requestApi,
  toLogQueryFields,
  toQuery,
  toSendTimeoutMs,
  unreadable,
  voteApi,
} from "./http.ts";
import type {
  ApiOptions,
  ApiPath,
  AskBody,
  AttachmentBody,
  AttachmentSource,
  Ballot,
  CallOptions,
  CallerOptions,
  Done,
  Failure,
  LogFilter,
  Message,
  NotifyBody,
  Pending,
  Question,
  QuestionState,
  StateBody,
  VoteBody,
  VoteOutcome,
} from "./types.ts";

type Session = { readonly endpoint: URL; readonly token?: string };

/**
 * Every call jaypost makes to its own service, local or remote. Never throws; aborts come back as
 * `cancelled`.
 */
export class Caller {
  #endpoint: CallerOptions["endpoint"];
  #readToken: CallerOptions["readToken"];
  #now: () => number;

  constructor(options: CallerOptions) {
    this.#endpoint = options.endpoint;
    this.#readToken = options.readToken;
    this.#now = options.now ?? (() => performance.now());
  }

  /** Resolves once the owner answers, or the timeout answer comes back. */
  async ask(question: Question, call: CallOptions): Promise<Done | Failure> {
    const session = this.#begin();
    if (session.kind === "failed") {
      return session;
    }
    const attachment = await this.#attach(
      question.attachment,
      session,
      call.signal,
    );
    if (attachment.kind === "failed") {
      return attachment;
    }
    const result = await requestApi(
      session.endpoint,
      { ...toAskBody(question, attachment.body), ...toRetryField(question) },
      { ...this.#apiOptions(session, call.signal), now: this.#now },
    );
    if (result.kind === "failed") {
      return result;
    }
    return { kind: "done", ...result.outcome };
  }

  /**
   * Asks every voter on `ballot` the two-way `question` (`options` is `[approve, reject]` and
   * `timeoutOption` the reject answer) and resolves once the vote is decided.
   */
  async vote(
    question: Question,
    ballot: Ballot,
    call: CallOptions,
  ): Promise<VoteOutcome> {
    const session = this.#begin();
    if (session.kind === "failed") {
      return session;
    }
    const attachment = await this.#attach(
      question.attachment,
      session,
      call.signal,
    );
    if (attachment.kind === "failed") {
      return attachment;
    }
    const body: VoteBody = {
      ...toAskBody(question, attachment.body),
      ...toRetryField(question),
      ...(ballot.voters === undefined ? {} : { voters: ballot.voters }),
      ...(ballot.rule === undefined ? {} : { require: ballot.rule }),
    };
    return voteApi(
      session.endpoint,
      body,
      this.#apiOptions(session, call.signal),
    );
  }

  /** Starts a question the owner answers later; collect it with `waitFor`. */
  async askInBackground(
    question: Question,
    call: CallOptions,
  ): Promise<Pending | Failure> {
    const session = this.#begin();
    if (session.kind === "failed") {
      return session;
    }
    const attachment = await this.#attach(
      question.attachment,
      session,
      call.signal,
    );
    if (attachment.kind === "failed") {
      return attachment;
    }
    const result = await postApi(
      session.endpoint,
      "/request/async",
      toAskBody(question, attachment.body),
      {
        ...this.#apiOptions(session, call.signal),
        timeoutMs: toSendTimeoutMs(attachment.body !== undefined),
      },
    );
    if (result.kind === "failed") {
      return result;
    }
    if (!isStateBody(result.body) || result.body.state !== "pending") {
      return unreadable(JSON.stringify(result.body));
    }
    return {
      kind: "pending",
      id: result.body.id,
      expiresAt: result.body.expiresAt,
    };
  }

  /** Long-polls until settled or `waitSeconds` passes; 0 checks once, omitted waits until settled. */
  async waitFor(
    id: string,
    call: CallOptions & { readonly waitSeconds?: number },
  ): Promise<QuestionState> {
    const session = this.#begin();
    if (session.kind === "failed") {
      return session;
    }
    const path = `/request/${encodeURIComponent(id)}` as const;
    const deadlineMs =
      call.waitSeconds === undefined
        ? undefined
        : this.#now() + call.waitSeconds * 1000;
    for (;;) {
      const remainingSeconds =
        deadlineMs === undefined
          ? MAX_WAIT_SECONDS
          : Math.max(0, (deadlineMs - this.#now()) / 1000);
      const waitSeconds = Math.min(remainingSeconds, MAX_WAIT_SECONDS);
      const result = await callApi(
        session.endpoint,
        "GET",
        `${path}?wait=${waitSeconds}`,
        undefined,
        {
          ...this.#apiOptions(session, call.signal),
          timeoutMs: waitSeconds * 1000 + FETCH_GRACE_MS,
        },
      );
      if (result.kind === "failed") {
        return result;
      }
      if (!isStateBody(result.body)) {
        return unreadable(JSON.stringify(result.body));
      }
      const isDue = deadlineMs !== undefined && this.#now() >= deadlineMs;
      if (result.body.state !== "pending" || isDue) {
        return toQuestionState(result.body);
      }
    }
  }

  /** Cancels a background question; the state that comes back is the settled one. */
  async cancel(
    id: string,
    call: CallOptions & { readonly timeoutMs?: number },
  ): Promise<QuestionState> {
    const session = this.#begin();
    if (session.kind === "failed") {
      return session;
    }
    const result = await callApi(
      session.endpoint,
      "DELETE",
      `/request/${encodeURIComponent(id)}`,
      undefined,
      {
        ...this.#apiOptions(session, call.signal),
        timeoutMs: call.timeoutMs ?? FETCH_GRACE_MS,
      },
    );
    if (result.kind === "failed") {
      return result;
    }
    if (!isStateBody(result.body)) {
      return unreadable(JSON.stringify(result.body));
    }
    return toQuestionState(result.body);
  }

  /** Resolves once the service has sent the message. */
  async notify(
    message: Message,
    call: CallOptions,
  ): Promise<{ readonly kind: "sent" } | Failure> {
    const session = this.#begin();
    if (session.kind === "failed") {
      return session;
    }
    const attachment = await this.#attach(
      message.attachment,
      session,
      call.signal,
    );
    if (attachment.kind === "failed") {
      return attachment;
    }
    const result = await postApi(
      session.endpoint,
      "/notify",
      toNotifyBody(message, attachment.body),
      {
        ...this.#apiOptions(session, call.signal),
        timeoutMs: toSendTimeoutMs(attachment.body !== undefined),
      },
    );
    return result.kind === "failed" ? result : { kind: "sent" };
  }

  /** The daemon's `/status`; `timeoutMs` defaults to the HTTP grace period. */
  async status(
    call: CallOptions & { readonly timeoutMs?: number },
  ): Promise<
    { readonly kind: "status"; readonly status: StatusInfo } | Failure
  > {
    const session = this.#begin();
    if (session.kind === "failed") {
      return session;
    }
    return this.#fetchStatus(
      session,
      call.signal,
      call.timeoutMs ?? FETCH_GRACE_MS,
    );
  }

  /** The questions of this caller's key from GET /log, oldest first. */
  async readLog(
    filter: LogFilter,
    call: CallOptions,
  ): Promise<{ readonly kind: "log"; readonly page: LogPage } | Failure> {
    const session = this.#begin();
    if (session.kind === "failed") {
      return session;
    }
    const query = toQuery(toLogQueryFields(filter));
    const path: ApiPath = query === "" ? "/log" : `/log?${query.slice(1)}`;
    const result = await callApi(session.endpoint, "GET", path, undefined, {
      ...this.#apiOptions(session, call.signal),
      timeoutMs: FETCH_GRACE_MS,
    });
    if (result.kind === "failed") {
      return result;
    }
    const parsed = logPageSchema.safeParse(result.body);
    if (!parsed.success) {
      return unreadable(JSON.stringify(result.body));
    }
    return { kind: "log", page: parsed.data };
  }

  #begin(): ({ readonly kind: "session" } & Session) | Failure {
    if (this.#endpoint.kind === "invalid") {
      return {
        kind: "failed",
        reason: "invalidUrl",
        message: this.#endpoint.message,
      };
    }
    const endpoint = this.#endpoint.url;
    const token = this.#readToken();
    switch (token.kind) {
      case "unusable":
        return {
          kind: "failed",
          reason: "unusableToken",
          message: token.message,
        };
      case "token":
        return { kind: "session", endpoint, token: token.token };
      case "none":
        return { kind: "session", endpoint };
    }
  }

  #apiOptions(
    session: Session,
    signal: AbortSignal,
  ): Omit<ApiOptions, "timeoutMs"> {
    return {
      signal,
      ...(session.token === undefined ? {} : { token: session.token }),
    };
  }

  async #fetchStatus(
    session: Session,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<
    { readonly kind: "status"; readonly status: StatusInfo } | Failure
  > {
    const result = await callApi(
      session.endpoint,
      "GET",
      "/status",
      undefined,
      {
        ...this.#apiOptions(session, signal),
        timeoutMs,
      },
    );
    if (result.kind === "failed") {
      return result;
    }
    const parsed = statusInfoSchema.safeParse(result.body);
    if (!parsed.success) {
      return unreadable(JSON.stringify(result.body));
    }
    return { kind: "status", status: parsed.data };
  }

  // Reads the file first, then asks the service for its limit, so a bad file or an old service
  // fails before any upload.
  async #attach(
    source: AttachmentSource | undefined,
    session: Session,
    signal: AbortSignal,
  ): Promise<
    { readonly kind: "ok"; readonly body?: AttachmentBody } | Failure
  > {
    if (source === undefined) {
      return { kind: "ok" };
    }
    const read = await readAttachment(source, signal);
    if (read.kind === "failed") {
      return read;
    }
    const status = await this.#fetchStatus(session, signal, FETCH_GRACE_MS);
    if (status.kind === "failed") {
      return status;
    }
    const checked = checkAttachmentLimit(
      read,
      status.status.maxAttachmentBytes,
    );
    return checked.kind === "failed"
      ? checked
      : { kind: "ok", body: checked.attachment };
  }
}

/** The `/ask` wire body for `question`, with the attachment already read and without `retry`. */
export function toAskBody(
  question: Question,
  attachment: AttachmentBody | undefined,
): AskBody {
  return {
    text: question.text,
    ...(question.options === undefined ? {} : { options: question.options }),
    ...(question.allowText === undefined
      ? {}
      : { allowText: question.allowText }),
    timeoutOption: question.timeoutOption,
    ...(question.timeout === undefined ? {} : { timeout: question.timeout }),
    ...(question.project === undefined ? {} : { project: question.project }),
    ...(question.format === undefined ? {} : { format: question.format }),
    ...(attachment === undefined ? {} : { attachment }),
  };
}

// Only /request and /vote take `retry`; /request/async answers 400 to it.
function toRetryField(question: Question): { readonly retry?: number } {
  return question.retry === undefined ? {} : { retry: question.retry };
}

/** The `/notify` wire body for `message`, with the attachment already read. */
export function toNotifyBody(
  message: Message,
  attachment: AttachmentBody | undefined,
): NotifyBody {
  return {
    text: message.text,
    ...(message.project === undefined ? {} : { project: message.project }),
    ...(message.format === undefined ? {} : { format: message.format }),
    ...(attachment === undefined ? {} : { attachment }),
    ...(message.deleteAfter === undefined
      ? {}
      : { deleteAfter: message.deleteAfter }),
  };
}

function toQuestionState(body: StateBody): QuestionState {
  switch (body.state) {
    case "pending":
      return { kind: "pending", id: body.id, expiresAt: body.expiresAt };
    case "done":
      return {
        kind: "done",
        id: body.id,
        answer: body.answer,
        timedOut: body.timedOut,
      };
    case "cancelled":
      return { kind: "cancelled", id: body.id };
  }
}
