import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parse } from "yaml";
import {
  applySeed,
  createEmptyRegistry,
  loadSeed,
  openDatabase,
  RegistryStore,
  resolveDatabasePath,
} from "@jaypost/store";
import { createPairingFakeProvider } from "@jaypost/testing";
import { main } from "../src/cli.ts";
import { VERSION } from "../src/constants.ts";

let isolatedConfigHome = "";

// A dev shell with JAYPOST_BOT exported must not reach the real contact book.
beforeEach(() => {
  isolatedConfigHome = mkdtempSync(join(tmpdir(), "jaypost-cli-isolated-"));
  vi.stubEnv("XDG_CONFIG_HOME", isolatedConfigHome);
  vi.stubEnv("JAYPOST_BOT", "");
  vi.stubEnv("JAYPOST_URL", "");
  vi.stubEnv("JAYPOST_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(isolatedConfigHome, { recursive: true, force: true });
});

test("unknown command returns 2", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(await main(["nope"])).toBe(2);
});

test("--version prints VERSION", async () => {
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  expect(await main(["--version"])).toBe(0);
  expect(write).toHaveBeenCalledWith(`${VERSION}\n`);
});

test("service install rejects bad port and unknown target with 2", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(await main(["service", "install", "--port", "abc"])).toBe(2);
  expect(await main(["service", "install", "--port", "70000"])).toBe(2);
  expect(await main(["service", "install", "nope"])).toBe(2);
});

test("init is an unknown command", async () => {
  const write = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  for (const command of ["init", "uninstall", "start"]) {
    write.mockClear();
    expect(await main([command])).toBe(2);
    expect(
      write.mock.calls
        .map((call: readonly unknown[]) => String(call[0]))
        .join(""),
    ).toContain(`unknown command '${command}'`);
  }
});

test("service --help lists install, uninstall, start, stop and run", async () => {
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  expect(await main(["service", "--help"])).toBe(0);
  const help = write.mock.calls
    .map((call: readonly unknown[]) => String(call[0]))
    .join("");
  for (const command of ["install", "uninstall", "start", "stop", "run"]) {
    expect(help).toMatch(new RegExp(`^\\s+${command}\\b`, "m"));
  }
});

test("log rejects bad --since, --limit and empty --project with 2", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(await main(["log", "--since", "soon"])).toBe(2);
  expect(await main(["log", "--since", "99999999999d"])).toBe(2);
  expect(await main(["log", "-n", "0"])).toBe(2);
  expect(await main(["log", "-n", "x"])).toBe(2);
  expect(await main(["log", "--project", " "])).toBe(2);
});

test("service install --help lists --provider and --exposed", async () => {
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  expect(await main(["service", "install", "--help"])).toBe(0);
  const help = write.mock.calls
    .map((call: readonly unknown[]) => String(call[0]))
    .join("");
  expect(help).toContain("--exposed");
  expect(help).toContain("--provider <name>");
});

test("service install --help lists --token and --no-token", async () => {
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  expect(await main(["service", "install", "--help"])).toBe(0);
  const help = write.mock.calls.map((call) => String(call[0])).join("");
  expect(help).toContain("--token ");
  expect(help).toContain("--no-token");
});

test("setup-ci --help lists --provider", async () => {
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  expect(await main(["setup-ci", "--help"])).toBe(0);
  expect(write.mock.calls.map((call) => String(call[0])).join("")).toContain(
    "--provider <name>",
  );
});

test("setup-ci --provider nope exits 2", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(await main(["setup-ci", "--provider", "nope"])).toBe(2);
});

test("setup-ci --approvers-only exits 2", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(await main(["setup-ci", "--approvers-only"])).toBe(2);
});

test("pair --help lists approver", async () => {
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  expect(await main(["pair", "--help"])).toBe(0);
  const help = write.mock.calls.map((call) => String(call[0])).join("");
  expect(help).toContain("Usage: jaypost pair");
  expect(help).toMatch(/^\s+approver\b/m);
});

test("pair approver --provider nope exits 2", async () => {
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  expect(await main(["pair", "approver", "--provider", "nope"])).toBe(2);
  expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
    "--provider",
  );
});

test("--port is an unknown option on every client command but openapi", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  for (const command of [
    ["ping"],
    ["status"],
    ["request", "Deploy?", "-o", "Yes", "-d", "No"],
    ["notify", "hi"],
    ["log"],
    ["mcp"],
    ["hook"],
  ]) {
    expect(await main([...command, "--port", "1"])).toBe(2);
  }
});

test("request needs -o or --allow-text", async () => {
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  expect(await main(["request", "Deploy?", "-d", "No"])).toBe(2);
  expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
    "--allow-text",
  );
});

test("request --allow-text without -o reaches the service", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  // An invalid token makes send exit 1 before any network call; a usage error would be 2.
  vi.stubEnv("JAYPOST_TOKEN", "short-secret");
  const ask = ["request", "Which?", "--allow-text", "-d", "main"];
  expect(await main(ask)).toBe(1);
});

test("request requires a default, and rejects a bad timeout", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(await main(["request", "Deploy?", "-o", "Yes", "-o", "No"])).toBe(2);
  expect(
    await main(["request", "Deploy?", "-o", "Yes", "--timeout-option", "No"]),
  ).toBe(2);
  const ask = ["request", "Deploy?", "-o", "Yes", "-d", "No"];
  expect(await main([...ask, "--timeout", "0"])).toBe(2);
  expect(await main([...ask, "--timeout", "soon"])).toBe(2);
});

test("request adds the default as the last button unless an option names it or --allow-text", async () => {
  const bodies: unknown[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      bodies.push(JSON.parse(body));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ answer: "Decline", timedOut: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv(
    "JAYPOST_URL",
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const ask = ["request", "Deploy?"];
    expect(await main([...ask, "-o", "Approve", "-d", "Decline"])).toBe(0);
    expect(
      await main([
        ...ask,
        "-o",
        "Decline",
        "-o",
        "Approve",
        "--default",
        "Decline",
      ]),
    ).toBe(0);
    expect(
      await main([...ask, "-o", "Approve", "--allow-text", "-d", "Decline"]),
    ).toBe(0);
  } finally {
    server.close();
  }
  expect(bodies).toEqual([
    {
      text: "Deploy?",
      options: ["Approve", "Decline"],
      timeoutOption: "Decline",
    },
    {
      text: "Deploy?",
      options: ["Decline", "Approve"],
      timeoutOption: "Decline",
    },
    {
      text: "Deploy?",
      options: ["Approve"],
      allowText: true,
      timeoutOption: "Decline",
    },
  ]);
});

async function listenForRequests(): Promise<{
  readonly port: number;
  readonly urls: (string | undefined)[];
  readonly close: () => void;
}> {
  const urls: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    urls.push(request.url);
    request.resume();
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ answer: "Approve", timedOut: false }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    urls,
    close: () => server.close(),
  };
}

test("ping uses JAYPOST_URL in env mode, over the install", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cli-test-port-"));
  const listener = await listenForRequests();
  const installListener = await listenForRequests();
  mkdirSync(join(directory, "jaypost", "service"), { recursive: true });
  writeFileSync(
    join(directory, "jaypost", "service", "install.json"),
    JSON.stringify({
      target: "systemd",
      port: installListener.port,
      version: VERSION,
    }),
  );
  vi.stubEnv("XDG_CONFIG_HOME", directory);
  vi.stubEnv("JAYPOST_URL", `http://127.0.0.1:${listener.port}`);
  vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await main(["ping"])).toBe(0);
  } finally {
    listener.close();
    installListener.close();
    rmSync(directory, { recursive: true, force: true });
  }
  expect(listener.urls).toEqual(["/notify"]);
  expect(installListener.urls).toEqual([]);
});

test("ping sends to the book default, and -b picks another bot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cli-test-book-"));
  const first = await listenForRequests();
  const second = await listenForRequests();
  mkdirSync(join(directory, "jaypost"), { recursive: true });
  writeFileSync(
    join(directory, "jaypost", "bots.json"),
    JSON.stringify({
      version: 1,
      default: "home",
      remotes: [],
      bots: [
        { alias: "home", url: `http://127.0.0.1:${first.port}/` },
        { alias: "work", url: `http://127.0.0.1:${second.port}/` },
      ],
    }),
  );
  vi.stubEnv("XDG_CONFIG_HOME", directory);
  vi.stubEnv("JAYPOST_URL", "");
  vi.stubEnv("JAYPOST_TOKEN", "");
  vi.stubEnv("JAYPOST_PORT", "");
  vi.stubEnv("JAYPOST_BOT", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await main(["ping"])).toBe(0);
    expect(await main(["ping", "-b", "work"])).toBe(0);
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
  expect(first.urls).toEqual(["/notify"]);
  expect(second.urls).toEqual(["/notify"]);
});

test("ping -b with an unknown alias exits 1 and lists the known ones", () => {
  const directory = mkdtempSync(join(tmpdir(), "cli-test-book-"));
  mkdirSync(join(directory, "jaypost"), { recursive: true });
  writeFileSync(
    join(directory, "jaypost", "bots.json"),
    JSON.stringify({
      version: 1,
      default: "home",
      remotes: [],
      bots: [{ alias: "home", url: "http://127.0.0.1:1/" }],
    }),
  );
  try {
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "..", "src", "cli.ts"), "ping", "-b", "nope"],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          XDG_CONFIG_HOME: directory,
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'no bot "nope" in your contacts; known: home',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("join with a garbage invite exits 1 without echoing it", () => {
  const directory = mkdtempSync(join(tmpdir(), "jaypost-join-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "..", "src", "cli.ts"),
        "join",
        "jpi_garbage-secret-text",
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          XDG_CONFIG_HOME: directory,
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "that isn't a valid invite; ask for a new one",
    );
    expect(result.stderr).not.toContain("garbage-secret-text");
    expect(result.stdout).not.toContain("garbage-secret-text");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("remote list on an empty book prints No remotes.", () => {
  const directory = mkdtempSync(join(tmpdir(), "jaypost-remote-"));
  try {
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "..", "src", "cli.ts"), "remote", "list"],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          XDG_CONFIG_HOME: directory,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("No remotes.\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bots on an empty book says how to add one", () => {
  const directory = mkdtempSync(join(tmpdir(), "jaypost-bots-"));
  try {
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "..", "src", "cli.ts"), "bots"],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          XDG_CONFIG_HOME: directory,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      'No bots. Run "jaypost service install" or "jaypost join".\n',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("jaypost key list is an unknown command", async () => {
  const write = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  for (const command of [
    ["key", "list"],
    ["bot", "list"],
    ["pairing", "list"],
    ["admin-key", "rotate"],
  ]) {
    write.mockClear();
    expect(await main(command)).toBe(2);
    expect(
      write.mock.calls
        .map((call: readonly unknown[]) => String(call[0]))
        .join(""),
    ).toMatch(/unknown command/);
  }
});

test("admin --help lists bot, key, pairing, rotate-key and log", async () => {
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  expect(await main(["admin", "--help"])).toBe(0);
  const help = write.mock.calls
    .map((call: readonly unknown[]) => String(call[0]))
    .join("");
  for (const command of ["bot", "key", "pairing", "rotate-key", "log"]) {
    expect(help).toMatch(new RegExp(`^\\s+${command}\\b`, "m"));
  }
  expect(help).toContain("-s, --service <name>");
});

test("jaypost admin key list -s x and jaypost admin -s x key list both reach the remote x", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cli-test-admin-"));
  const other = await listenForRequests();
  const x = await listenForRequests();
  mkdirSync(join(directory, "jaypost"), { recursive: true });
  writeFileSync(
    join(directory, "jaypost", "bots.json"),
    JSON.stringify({
      version: 1,
      remotes: [
        {
          name: "other",
          url: `http://127.0.0.1:${other.port}/`,
          adminKey: `jpa_${"o".repeat(43)}`,
        },
        {
          name: "x",
          url: `http://127.0.0.1:${x.port}/`,
          adminKey: `jpa_${"x".repeat(43)}`,
        },
      ],
      bots: [],
    }),
  );
  vi.stubEnv("HOME", directory);
  vi.stubEnv("XDG_CONFIG_HOME", directory);
  vi.stubEnv("JAYPOST_URL", "");
  vi.stubEnv("JAYPOST_ADMIN_KEY", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await main(["admin", "key", "list", "-s", "x"]);
    await main(["admin", "-s", "x", "key", "list"]);
    await main(["admin", "key", "list", "--service", "x"]);
  } finally {
    other.close();
    x.close();
    rmSync(directory, { recursive: true, force: true });
  }
  expect(x.urls).toEqual(["/admin/keys", "/admin/keys", "/admin/keys"]);
  expect(other.urls).toEqual([]);
});

test("admin key create rejects --save with --invite and --as without --save with 2", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(
    await main(["admin", "key", "create", "--bot", "b1", "--save", "--invite"]),
  ).toBe(2);
  expect(
    await main(["admin", "key", "create", "--bot", "b1", "--as", "ops"]),
  ).toBe(2);
});

test.each([
  ["request", "Deploy?", "-o", "Yes", "-d", "No"],
  ["notify", "hi"],
  ["log"],
  ["status"],
])(
  "%s -b with an unknown alias exits 1 and lists the known ones",
  (...command) => {
    const directory = mkdtempSync(join(tmpdir(), "cli-test-book-"));
    mkdirSync(join(directory, "jaypost"), { recursive: true });
    writeFileSync(
      join(directory, "jaypost", "bots.json"),
      JSON.stringify({
        version: 1,
        default: "home",
        remotes: [],
        bots: [{ alias: "home", url: "http://127.0.0.1:1/" }],
      }),
    );
    try {
      const result = spawnSync(
        process.execPath,
        [
          join(import.meta.dirname, "..", "src", "cli.ts"),
          ...command,
          "-b",
          "nope",
        ],
        {
          encoding: "utf8",
          input:
            '{"session_id":"s1","hook_event_name":"SessionStart","source":"startup","cwd":"/w"}',
          timeout: 20_000,
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            XDG_CONFIG_HOME: directory,
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        'no bot "nope" in your contacts; known: home',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("hook -b with an unknown alias says so in the session start message and exits 0", () => {
  const directory = mkdtempSync(join(tmpdir(), "cli-test-book-"));
  mkdirSync(join(directory, "jaypost"), { recursive: true });
  writeFileSync(
    join(directory, "jaypost", "bots.json"),
    JSON.stringify({
      version: 1,
      default: "home",
      remotes: [],
      bots: [{ alias: "home", url: "http://127.0.0.1:1/" }],
    }),
  );
  try {
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "..", "src", "cli.ts"), "hook", "-b", "nope"],
      {
        encoding: "utf8",
        input:
          '{"session_id":"s1","hook_event_name":"SessionStart","source":"startup","cwd":"/w"}',
        timeout: 20_000,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          XDG_CONFIG_HOME: directory,
        },
      },
    );
    // A hook never fails the session; it reports through its system message instead.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'no bot \\"nope\\" in your contacts; known: home',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ping --port is an unknown option", () => {
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "..", "src", "cli.ts"), "ping", "--port", "1"],
    { encoding: "utf8", env: { PATH: process.env.PATH } },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("unknown option '--port'");
});

test("notify requires text", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(await main(["notify"])).toBe(2);
});

test("the old send request, send notify and test spellings still run", async () => {
  const listener = await listenForRequests();
  vi.stubEnv("JAYPOST_URL", `http://127.0.0.1:${listener.port}`);
  vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(
      await main(["send", "request", "Deploy?", "-o", "Yes", "-d", "No"]),
    ).toBe(0);
    expect(await main(["send", "notify", "hi"])).toBe(0);
    expect(await main(["test"])).toBe(0);
  } finally {
    listener.close();
  }
  expect(listener.urls).toEqual(["/request", "/notify", "/notify"]);
});

test("hook rejects a bad timeout and positional arguments with 2", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(await main(["hook", "--timeout", "0"])).toBe(2);
  expect(await main(["hook", "extra"])).toBe(2);
});

test("send exits 1 with the message on an invalid JAYPOST_TOKEN", async () => {
  vi.stubEnv("JAYPOST_TOKEN", "short-secret");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await main(["notify", "hi"])).toBe(1);
  expect(error).toHaveBeenCalledWith(
    "jaypost: JAYPOST_TOKEN isn't a valid jaypost token",
  );
});

test("send rejects an unknown JAYPOST_MODE with 2", async () => {
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  vi.stubEnv("JAYPOST_MODE", "bogus");
  expect(await main(["request", "x", "-o", "a", "-d", "a"])).toBe(2);
  expect(await main(["notify", "x"])).toBe(2);
  expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
    'JAYPOST_MODE must be "direct" or "service", got "bogus"',
  );
});

test("direct send without a bot token exits 1 naming the env var", async () => {
  vi.stubEnv("JAYPOST_MODE", "direct");
  vi.stubEnv("JAYPOST_PROVIDER", "");
  vi.stubEnv("JAYPOST_BOT_TOKEN", "");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await main(["request", "x", "-o", "a", "-d", "a"])).toBe(1);
  expect(await main(["notify", "x"])).toBe(1);
  const output = error.mock.calls.map((call) => String(call[0])).join("\n");
  expect(output).toContain("missing bot token; set JAYPOST_BOT_TOKEN");
});

test("openapi writes the spec with the given port to a file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jaypost-openapi-"));
  try {
    const file = join(directory, "openapi.yaml");
    expect(await main(["openapi", "--port", "9999", file])).toBe(0);
    expect(parse(readFileSync(file, "utf8")).servers).toEqual([
      { url: "http://127.0.0.1:9999" },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("openapi for the discord provider carries its option limit", async () => {
  vi.stubEnv("JAYPOST_PROVIDER", "discord");
  vi.stubEnv("JAYPOST_BOT_TOKEN", "x");
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  expect(await main(["openapi", "--port", "9999"])).toBe(0);
  expect(String(write.mock.calls[0]?.[0])).toContain("25");
});

test("openapi prints the spec without a file", async () => {
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  expect(await main(["openapi", "--port", "9999"])).toBe(0);
  expect(String(write.mock.calls[0]?.[0])).toMatch(/^openapi: 3\.1\.0\n/);
});

test("openapi returns 1 when the file cannot be written", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await main(["openapi", "/nonexistent-directory/openapi.yaml"])).toBe(
    1,
  );
});

test("send rejects an unknown format with 2", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const ask = ["request", "Deploy?", "-o", "Yes", "-d", "Yes"];
  expect(await main([...ask, "--format", "html"])).toBe(2);
  expect(await main(["notify", "hi", "--format", "html"])).toBe(2);
});

function runAuditDump(args: readonly string[], directory: string) {
  return spawnSync(
    process.execPath,
    ["apps/cli/src/cli.ts", "audit", ...args],
    {
      env: { ...process.env, JAYPOST_CONFIG: join(directory, "config.json") },
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
    },
  );
}

/** Seeds `directory`'s db with the fakepair seed bot (b1) and one question row per id. */
function seedQuestions(directory: string, ids: readonly string[]): void {
  const configPath = join(directory, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ provider: "fakepair", fakeKey: "k", fakeOwner: "u1" }),
  );
  const providers = [createPairingFakeProvider()];
  const loaded = loadSeed({ JAYPOST_CONFIG: configPath }, providers);
  if (loaded.kind !== "seed") {
    throw new Error(loaded.message);
  }
  const seeded = applySeed(
    createEmptyRegistry(),
    loaded.seed,
    true,
    () => "SEED1111",
    new Date("2026-10-19T08:00:00Z"),
  );
  const database = openDatabase(resolveDatabasePath(configPath));
  try {
    new RegistryStore(database).save(seeded.registry);
    database.exec("BEGIN");
    const insert = database.prepare(
      "INSERT INTO questions (bot_id, id, asked_at, text, options, timeout_option, timeout_seconds) VALUES (?, ?, '2026-10-19T07:00:00.000Z', ?, ?, 'Decline', 300)",
    );
    for (const id of ids) {
      insert.run(
        id.startsWith("other") ? "b2" : "b1",
        id,
        `question ${id} ${"x".repeat(100)}`,
        '["Approve","Decline"]',
      );
    }
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

test("audit dump writes the seed bot's rows as jsonl, whole", () => {
  const directory = mkdtempSync(join(tmpdir(), "cli-audit-"));
  try {
    const ids = Array.from({ length: 2500 }, (_, index) => `id${index}`);
    seedQuestions(directory, [...ids, "other1"]);
    const result = runAuditDump(["dump"], directory);
    expect(result.status).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines).toHaveLength(2501);
    expect(result.stdout).not.toContain("other1");
    expect(result.stdout.length).toBeGreaterThan(65_536 * 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("audit dump with no db prints nothing, exits 0 and creates no db", () => {
  const directory = mkdtempSync(join(tmpdir(), "cli-audit-"));
  try {
    const result = runAuditDump(["dump"], directory);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(
      existsSync(resolveDatabasePath(join(directory, "config.json"))),
    ).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("audit with an unknown subcommand exits 2", () => {
  const directory = mkdtempSync(join(tmpdir(), "cli-audit-"));
  try {
    const result = runAuditDump(["nope"], directory);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage: audit dump");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Runs the CLI as a child so its stdout can be read through a real pipe. */
function runLogCli(
  args: readonly string[],
  url: string,
): Promise<{ readonly status: number | null; readonly stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["apps/cli/src/cli.ts", "log", ...args],
      {
        env: {
          ...process.env,
          JAYPOST_URL: url,
          JAYPOST_TOKEN: "",
          JAYPOST_BOT: "",
        },
      },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (status) =>
      resolve({ status, stdout: Buffer.concat(chunks).toString() }),
    );
  });
}

test("log writes output larger than a pipe buffer whole, as json and as a table", async () => {
  const entries = Array.from({ length: 2500 }, (_, index) => ({
    id: `id${index}`,
    askedAt: "2026-10-19T07:00:00.000Z",
    text: `question id${index} ${"x".repeat(100)}`,
    options: ["Approve", "Decline"],
    timeoutOption: "Decline",
    timeoutSeconds: 300,
    status: "pending",
  }));
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ entries, skippedCount: 0 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const json = await runLogCli(["--since", "2000-01-01", "--json"], url);
    expect(json.status).toBe(0);
    expect(json.stdout.length).toBeGreaterThan(65_536 * 3);
    const lines = json.stdout.split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines).toHaveLength(2501);
    expect(JSON.parse(lines[2499] ?? "").id).toBe("id2499");
    const table = await runLogCli(["--since", "2000-01-01"], url);
    expect(table.status).toBe(0);
    expect(table.stdout.length).toBeGreaterThan(65_536);
    expect(table.stdout.endsWith("\n")).toBe(true);
    expect(table.stdout.split("\n")).toHaveLength(2501);
  } finally {
    server.close();
  }
});

test("send --attach-name without --attach exits 2", async () => {
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  expect(
    await main([
      "request",
      "Deploy?",
      "-o",
      "Yes",
      "-d",
      "No",
      "--attach-name",
      "a",
    ]),
  ).toBe(2);
  expect(await main(["notify", "done", "--attach-name", "a"])).toBe(2);
  const output = stderr.mock.calls.map((call) => String(call[0])).join("");
  expect(output).toContain(
    "error: option '--attach-name <name>' needs '--attach <file>'",
  );
});

const REQUEST_ARGS = ["request", "Deploy?", "-o", "Yes", "-d", "No"];

test("vote and retry flags reach the service without direct mode", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("JAYPOST_MODE", "");
  // An invalid token makes send exit 1 before any network call; a usage error would be 2.
  vi.stubEnv("JAYPOST_TOKEN", "short-secret");
  for (const flags of [
    ["-u", "1"],
    ["--require", "all"],
    ["--retry", "2"],
  ]) {
    expect(await main([...REQUEST_ARGS, ...flags])).toBe(1);
  }
});

test("an empty JAYPOST_APPROVERS exits 2 in service mode too", async () => {
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  vi.stubEnv("JAYPOST_MODE", "");
  vi.stubEnv("JAYPOST_APPROVERS", "");
  expect(await main(REQUEST_ARGS)).toBe(2);
  const output = stderr.mock.calls.map((call) => String(call[0])).join("");
  expect(output).toContain("JAYPOST_APPROVERS is set but has no ids");
});

test("an empty JAYPOST_APPROVERS exits 2 in direct mode", async () => {
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  vi.stubEnv("JAYPOST_MODE", "direct");
  vi.stubEnv("JAYPOST_APPROVERS", " , ");
  expect(await main(REQUEST_ARGS)).toBe(2);
  const output = stderr.mock.calls.map((call) => String(call[0])).join("");
  expect(output).toContain("JAYPOST_APPROVERS is set but has no ids");
});

test("-u wins over an empty JAYPOST_APPROVERS", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.stubEnv("JAYPOST_MODE", "direct");
  vi.stubEnv("JAYPOST_APPROVERS", "");
  vi.stubEnv("JAYPOST_BOT_TOKEN", "");
  // 1: got past validation to the direct send, which fails on the missing token
  expect(await main([...REQUEST_ARGS, "-u", "1"])).toBe(1);
});

test("JAYPOST_APPROVERS makes the question a vote", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.stubEnv("JAYPOST_MODE", "direct");
  vi.stubEnv("JAYPOST_APPROVERS", "1,2");
  const args = [
    "send",
    "request",
    "Deploy?",
    "-o",
    "Yes",
    "-o",
    "Maybe",
    "-d",
    "No",
  ];
  expect(await main(args)).toBe(2);
});

test("send notify ignores JAYPOST_APPROVERS", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.stubEnv("JAYPOST_MODE", "direct");
  vi.stubEnv("JAYPOST_APPROVERS", "");
  vi.stubEnv("JAYPOST_BOT_TOKEN", "");
  expect(await main(["send", "notify", "done"])).toBe(1);
});

test("a vote needs one -o and a different -d without --allow-text", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.stubEnv("JAYPOST_MODE", "direct");
  const base = ["request", "Deploy?"];
  expect(
    await main([...base, "-o", "Yes", "-o", "Maybe", "-d", "No", "-u", "1"]),
  ).toBe(2);
  expect(
    await main([...base, "--allow-text", "-d", "No", "--require", "all"]),
  ).toBe(2);
  expect(await main([...base, "-o", "No", "-d", "No", "-u", "1"])).toBe(2);
});

test("--require only takes all or majority", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.stubEnv("JAYPOST_MODE", "direct");
  expect(await main([...REQUEST_ARGS, "--require", "some"])).toBe(2);
});

test("--retry rejects a negative or non-integer count", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.stubEnv("JAYPOST_MODE", "direct");
  for (const count of ["-1", "1.5", "x", "", "101"]) {
    expect(await main([...REQUEST_ARGS, "--retry", count])).toBe(2);
  }
});

test("valid vote and retry flags pass validation and reach the direct send", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.stubEnv("JAYPOST_MODE", "direct");
  vi.stubEnv("JAYPOST_BOT_TOKEN", "");
  const flags = ["-u", "1", "-u", "2", "--require", "majority", "--retry", "3"];
  expect(await main([...REQUEST_ARGS, ...flags])).toBe(1);
  expect(await main([...REQUEST_ARGS, "--retry", "0"])).toBe(1);
});

test("a bad url in the contact book fails bots, ping -b and admin -s naming the file, with no stack", () => {
  const directory = mkdtempSync(join(tmpdir(), "jaypost-badurl-"));
  const path = join(directory, "jaypost", "bots.json");
  mkdirSync(join(directory, "jaypost"), { recursive: true });
  const text = JSON.stringify({
    version: 1,
    remotes: [{ name: "r", url: "nope", adminKey: "jpa_x" }],
    bots: [{ alias: "a", url: "not a url", key: "jpk_x" }],
  });
  writeFileSync(path, text);
  try {
    for (const args of [
      ["bots"],
      ["ping", "-b", "a"],
      ["admin", "-s", "r", "bot", "list"],
      ["remote", "list"],
    ]) {
      const result = spawnSync(
        process.execPath,
        ["apps/cli/src/cli.ts", ...args],
        {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            XDG_CONFIG_HOME: directory,
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `contact book ${JSON.stringify(path)} isn't valid`,
      );
      expect(result.stderr).not.toContain("not a url");
      expect(result.stderr).not.toContain("nope");
      expect(result.stderr).not.toMatch(/\n\s+at /);
    }
    expect(readFileSync(path, "utf8")).toBe(text);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
