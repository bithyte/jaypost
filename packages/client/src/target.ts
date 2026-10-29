import {
  BOT_ENV_VAR,
  DEFAULT_PORT,
  findEnvValue,
  NO_CLIENT_TOKEN,
  PORT_ENV_VAR,
  readBook,
  resolveBookPath,
  resolveBotTarget,
  resolveEnvToken,
  TOKEN_ENV_VAR,
  URL_ENV_VAR,
} from "@jaypost/store";
import { findEnvEndpoint, toLocalEndpoint } from "./endpoint.ts";
import type { ResolvedBot } from "./types.ts";

/**
 * The service and token a call goes to: the book bot named by `alias` or $JAYPOST_BOT, else env
 * mode (JAYPOST_URL, JAYPOST_TOKEN, JAYPOST_PORT; the book isn't read), else the book default. A
 * book key never goes to an env URL and an env token never goes to a book URL. Never throws: a
 * failure is an `invalid` endpoint carrying the message, with no token. Messages never hold a key.
 */
export function resolveBot(
  env: NodeJS.ProcessEnv,
  alias: string | undefined,
): ResolvedBot {
  const name = alias ?? findEnvValue(env, BOT_ENV_VAR);
  if (name === undefined && hasEnvTarget(env)) {
    return resolveEnvBot(env);
  }
  const path = resolveBookPath(env);
  let book;
  try {
    book = readBook(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // readBook names the file for bad contents; an I/O error needs the path added.
    return toFailure(
      message.includes(path)
        ? message
        : `contact book ${JSON.stringify(path)} couldn't be read: ${message}`,
    );
  }
  const target = resolveBotTarget(env, book, alias);
  switch (target.kind) {
    case "env":
      return resolveEnvBot(env);
    case "failed":
      return toFailure(target.message);
    case "bot":
      return {
        endpoint: { kind: "url", url: new URL(target.bot.url) },
        token:
          target.bot.key === undefined
            ? NO_CLIENT_TOKEN
            : { kind: "token", token: target.bot.key, source: "book" },
        alias: target.bot.alias,
      };
  }
}

function hasEnvTarget(env: NodeJS.ProcessEnv): boolean {
  return (
    findEnvValue(env, URL_ENV_VAR) !== undefined ||
    findEnvValue(env, TOKEN_ENV_VAR) !== undefined
  );
}

function resolveEnvBot(env: NodeJS.ProcessEnv): ResolvedBot {
  return {
    endpoint:
      findEnvEndpoint(env) ?? toLocalEndpoint(findEnvPort(env) ?? DEFAULT_PORT),
    token: resolveEnvToken(env),
    alias: undefined,
  };
}

function findEnvPort(env: NodeJS.ProcessEnv): number | undefined {
  const raw = findEnvValue(env, PORT_ENV_VAR);
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : undefined;
}

function toFailure(message: string): ResolvedBot {
  return {
    endpoint: { kind: "invalid", message },
    token: NO_CLIENT_TOKEN,
    alias: undefined,
  };
}
