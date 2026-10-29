import {
  ADMIN_KEY_ENV_VAR,
  DEFAULT_PORT,
  findEnvValue,
  findRemote,
  parseToken,
  PORT_ENV_VAR,
  readBook,
  readConfigFile,
  resolveAdminKey,
  resolveAdminKeyPath,
  resolveConfigPath,
  writeBook,
} from "@jaypost/store";
import type { Book, BookRemote } from "@jaypost/store";
import {
  ADMIN_KEY_REJECTED_MESSAGE,
  AdminCaller,
  findEnvEndpoint,
  LOCAL_KEY_REJECTED_MESSAGE,
  toLocalEndpoint,
  toRemoteKeyRejectedMessage,
} from "@jaypost/client";
import { findExistingInstall } from "@jaypost/install";
import type { InstallRecord, Target } from "@jaypost/install";
import { toLocalUrl } from "./constants.ts";
import type {
  AdminDeps,
  AdminEndpoint,
  AdminKeyLookup,
  LoadedBook,
  OpenedAdmin,
  ReachableEndpoint,
} from "./types.ts";

const PORT_PATTERN = /^\d{1,5}$/;

/** True for the installs whose service runs on this machine's files, not in a container. */
export function isNativeInstall(record: InstallRecord): boolean {
  return record.target === "systemd" || record.target === "launchd";
}

/** What finding the admin endpoint reads. */
type AdminAccessDeps = Pick<
  AdminDeps,
  "env" | "paths" | "targets" | "bookPath" | "service"
>;

/**
 * The admin caller for the service `resolveAdminEndpoint` picks; `noKey` for a service whose admin
 * key can't be found, or `failed`. Prints nothing. Never throws.
 */
export async function openAdmin(deps: AdminAccessDeps): Promise<OpenedAdmin> {
  const endpoint = await resolveAdminEndpoint(deps);
  if (endpoint.kind === "failed") {
    return endpoint;
  }
  if (endpoint.adminKey.kind === "missing") {
    return { kind: "noKey", endpoint, message: endpoint.adminKey.message };
  }
  const caller = new AdminCaller({
    endpoint: endpoint.endpoint,
    adminKey: endpoint.adminKey.adminKey,
    rejectedMessage: describeRejectedKey(
      endpoint,
      findEnvValue(deps.env, ADMIN_KEY_ENV_VAR),
    ),
  });
  return { kind: "opened", caller, endpoint };
}

// What fixes a refused key depends on where the key came from: the book's remote, the install's
// saved copy, or the environment (then the default message applies).
function describeRejectedKey(
  endpoint: ReachableEndpoint,
  envKey: string | undefined,
): string {
  if (envKey !== undefined) {
    return ADMIN_KEY_REJECTED_MESSAGE;
  }
  if (endpoint.kind === "remote") {
    return endpoint.name === undefined
      ? ADMIN_KEY_REJECTED_MESSAGE
      : toRemoteKeyRejectedMessage(endpoint.name);
  }
  return endpoint.install === undefined
    ? ADMIN_KEY_REJECTED_MESSAGE
    : LOCAL_KEY_REJECTED_MESSAGE;
}

/** `openAdmin`'s caller, or undefined once the reason is printed. Never throws. */
export async function openAdminCaller(
  deps: AdminDeps,
): Promise<AdminCaller | undefined> {
  const opened = await openAdmin(deps);
  if (opened.kind !== "opened") {
    deps.printError(opened.message);
    return undefined;
  }
  return opened.caller;
}

/** The book at `bookPath`, or failed with a message naming the file (never a value). */
export function loadBook(bookPath: string): LoadedBook {
  try {
    return { kind: "loaded", book: readBook(bookPath) };
  } catch (error) {
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Where the admin commands go: the remote `-s` names; else `JAYPOST_URL` with
 * `JAYPOST_ADMIN_KEY`; else the local install's port, with the key from `JAYPOST_ADMIN_KEY`, the
 * book, or the install's target (then saved to the book); else the book's only remote; else, with
 * no remotes, 127.0.0.1 on `JAYPOST_PORT` or the config's port with the key from
 * `JAYPOST_ADMIN_KEY` or the admin key file next to the config; else failed asking for `-s`.
 * A corrupt book fails naming it. Never throws; never quotes a key.
 */
async function resolveAdminEndpoint(
  deps: AdminAccessDeps,
): Promise<AdminEndpoint> {
  const loaded = loadBook(deps.bookPath);
  if (loaded.kind === "failed") {
    return loaded;
  }
  const { book } = loaded;
  if (deps.service !== undefined) {
    return resolveNamedRemote(book, deps.service);
  }
  const { env, paths, targets } = deps;
  const remote = findEnvEndpoint(env);
  const rawEnvKey = findEnvValue(env, ADMIN_KEY_ENV_VAR);
  const envKey = rawEnvKey === undefined ? undefined : parseToken(rawEnvKey);
  if (rawEnvKey !== undefined && envKey === undefined) {
    return {
      kind: "failed",
      message: `${ADMIN_KEY_ENV_VAR} isn't a valid jaypost admin key`,
    };
  }
  if (remote !== undefined) {
    if (remote.kind === "invalid") {
      return { kind: "failed", message: remote.message };
    }
    return {
      kind: "remote",
      name: undefined,
      endpoint: remote,
      adminKey:
        envKey === undefined
          ? {
              kind: "missing",
              message: "JAYPOST_URL is set, so set JAYPOST_ADMIN_KEY too",
            }
          : { kind: "found", adminKey: envKey },
    };
  }
  const install = findExistingInstall(paths, targets, env)?.record;
  if (install !== undefined) {
    return {
      kind: "local",
      endpoint: toLocalEndpoint(install.port),
      port: install.port,
      adminKey:
        envKey === undefined
          ? await resolveInstallAdminKey(
              book,
              deps.bookPath,
              targets[install.target],
              install,
            )
          : { kind: "found", adminKey: envKey },
      install,
      configPath: isNativeInstall(install)
        ? (install.configFile ?? resolveConfigPath(env))
        : undefined,
    };
  }
  const [onlyRemote, ...otherRemotes] = book.remotes;
  if (onlyRemote !== undefined && otherRemotes.length === 0) {
    return toRemoteEndpoint(onlyRemote);
  }
  if (onlyRemote !== undefined) {
    return {
      kind: "failed",
      message: `several remotes; pick one with -s: ${book.remotes.map((each) => each.name).join(", ")}`,
    };
  }
  const configPath = resolveConfigPath(env);
  const port = resolveLocalPort(env, configPath);
  return {
    kind: "local",
    endpoint: toLocalEndpoint(port),
    port,
    adminKey: toAdminKeyLookup(
      resolveAdminKey(env, resolveAdminKeyPath(configPath)),
      configPath,
    ),
    install: undefined,
    configPath,
  };
}

/** The remote `-s` names, or failed listing the known names. */
function resolveNamedRemote(book: Book, name: string): AdminEndpoint {
  const remote = findRemote(book, name);
  if (remote !== undefined) {
    return toRemoteEndpoint(remote);
  }
  const hint =
    book.remotes.length === 0
      ? 'add one with "jaypost remote add"'
      : `known: ${book.remotes.map((each) => each.name).join(", ")}`;
  return { kind: "failed", message: `no remote "${name}"; ${hint}` };
}

function toRemoteEndpoint(remote: BookRemote): AdminEndpoint {
  return {
    kind: "remote",
    name: remote.name,
    endpoint: { kind: "url", url: new URL(remote.url) },
    adminKey: { kind: "found", adminKey: remote.adminKey },
  };
}

/**
 * The local install's admin key: the book's copy, else the target's, which is then saved to the
 * book so later commands skip the target.
 */
async function resolveInstallAdminKey(
  book: Book,
  bookPath: string,
  target: Target,
  record: InstallRecord,
): Promise<AdminKeyLookup> {
  const saved = book.local?.adminKey;
  if (saved !== undefined) {
    return { kind: "found", adminKey: saved };
  }
  const read = await readTargetAdminKey(target, record);
  if (read.kind === "missing") {
    return read;
  }
  const url = book.local?.url ?? toLocalUrl(record.port).href;
  try {
    writeBook(bookPath, { ...book, local: { url, adminKey: read.adminKey } });
  } catch {
    // The book only saves a lookup; the key just read works without it.
  }
  return read;
}

async function readTargetAdminKey(
  target: Target,
  record: InstallRecord,
): Promise<AdminKeyLookup> {
  try {
    return { kind: "found", adminKey: await target.readAdminKey(record) };
  } catch (error) {
    return {
      kind: "missing",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function toAdminKeyLookup(
  token: ReturnType<typeof resolveAdminKey>,
  configPath: string,
): AdminKeyLookup {
  switch (token.kind) {
    case "token":
      return { kind: "found", adminKey: token.token };
    case "unusable":
      return { kind: "missing", message: token.message };
    case "none":
      return {
        kind: "missing",
        message: `no admin key in ${JSON.stringify(resolveAdminKeyPath(configPath))} yet; start the service once so it writes one`,
      };
  }
}

/** `JAYPOST_PORT` when valid, else the config file's port, else the default. Never throws. */
function resolveLocalPort(env: NodeJS.ProcessEnv, configPath: string): number {
  const raw = findEnvValue(env, PORT_ENV_VAR);
  const envPort =
    raw !== undefined && PORT_PATTERN.test(raw) ? Number(raw) : undefined;
  if (envPort !== undefined && envPort >= 1 && envPort <= 65_535) {
    return envPort;
  }
  try {
    return readConfigFile(configPath).port ?? DEFAULT_PORT;
  } catch {
    // An unreadable config: the service couldn't start from it either, so the default it is.
    return DEFAULT_PORT;
  }
}
