import { describe, expect, it } from "bun:test";
import {
  buildZellijSpawnArgs,
  createPlugin,
  validateSessionId,
  type SessionProvider,
} from "../src/index.js";

const MALICIOUS_PAYLOADS = [
  "$(whoami)",
  "abc$(touch /tmp/pwn)",
  "`id`",
  "abc`id`",
  "abc;id",
  "abc&id",
  "abc&&id",
  "abc|id",
  "abc>out",
  "abc<in",
  'abc"$(id)"',
  "abc'$(id)'",
  "abc def",
  "abc\nid",
  "../etc/passwd",
  "abc/def",
  "",
  "a".repeat(129),
];

describe("BOFF-16054: Zellij session ID validation and safe spawn argv", () => {
  it("accepts valid alphanumeric, underscore, and hyphen session IDs", () => {
    for (const valid of [
      "a1b2c3d4",
      "550e8400-e29b-41d4-a716-446655440000",
      "session_01-prod",
      "ZELLIJ_TEST_99",
    ]) {
      expect(validateSessionId(valid)).toBe(valid);
    }
  });

  it("rejects shell metacharacter payloads in validateSessionId", () => {
    for (const payload of MALICIOUS_PAYLOADS) {
      expect(() => validateSessionId(payload)).toThrow(/Invalid session id/);
    }
  });

  it("invokes script directly on Linux without sh -c and quotes zellij binary", () => {
    const args = buildZellijSpawnArgs(
      "/usr/local/bin/zellij",
      "vibe-a1b2c3d4",
      "linux",
    );
    expect(args[0]).toBe("script");
    expect(args).not.toContain("sh");
    expect(args).toEqual([
      "script",
      "-qfc",
      "'/usr/local/bin/zellij' -s vibe-a1b2c3d4",
      "/dev/null",
    ]);

    const quotedPathArgs = buildZellijSpawnArgs(
      "/opt/my's tools/zellij",
      "vibe-a1b2c3d4",
      "linux",
    );
    expect(quotedPathArgs).toEqual([
      "script",
      "-qfc",
      "'/opt/my'\\''s tools/zellij' -s vibe-a1b2c3d4",
      "/dev/null",
    ]);
  });

  it("invokes script directly with argv passthrough on macOS and zellij directly on Windows", () => {
    expect(
      buildZellijSpawnArgs(
        "/opt/homebrew/bin/zellij",
        "vibe-abcd1234",
        "darwin",
      ),
    ).toEqual([
      "script",
      "-q",
      "/dev/null",
      "/opt/homebrew/bin/zellij",
      "-s",
      "vibe-abcd1234",
    ]);

    expect(
      buildZellijSpawnArgs("C:\\tools\\zellij.exe", "vibe-abcd1234", "win32"),
    ).toEqual(["C:\\tools\\zellij.exe", "-s", "vibe-abcd1234"]);
  });

  it("rejects shell metacharacters in sessionName and control chars in zellijCmd", () => {
    for (const payload of MALICIOUS_PAYLOADS) {
      expect(() =>
        buildZellijSpawnArgs("/usr/bin/zellij", payload, "linux"),
      ).toThrow(/Invalid zellij session name/);
    }
    expect(() =>
      buildZellijSpawnArgs("/usr/bin/zellij\nid", "vibe-12345678", "linux"),
    ).toThrow(/Invalid zellij binary path/);
    expect(() => buildZellijSpawnArgs("", "vibe-12345678", "linux")).toThrow(
      /Invalid zellij binary path/,
    );
  });

  it("provider.create() rejects malicious config.id before spawning any process", async () => {
    let registeredProvider: SessionProvider | null = null;
    const plugin = createPlugin({} as never);
    const fakeHostServices = {
      serviceRegistry: {
        registerProvider: (
          _type: string,
          provider: SessionProvider,
          _name: string,
        ) => {
          registeredProvider = provider;
        },
        unregisterProvider: () => {},
      },
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    };

    // Register provider via onServerStart without requiring zellij binary if absent
    const originalSpawn = Bun.spawn;
    const spawnCalls: unknown[][] = [];
    Bun.spawn = ((...args: unknown[]) => {
      spawnCalls.push(args);
      return originalSpawn(...(args as Parameters<typeof Bun.spawn>));
    }) as typeof Bun.spawn;

    try {
      // Directly exercise onServerStart to obtain the registered provider
      // (skip full init binary downloads if zellij isn't installed by checking registerProvider)
      const startPromise = plugin.onServerStart?.(
        {} as never,
        fakeHostServices as never,
      );
      await startPromise?.catch(() => undefined);
      expect(registeredProvider).not.toBeNull();

      spawnCalls.length = 0;
      for (const payload of [
        "$(id)",
        "`id`",
        "a;id",
        "a&id",
        'a"b',
        "a'b",
        "a>out",
        "a<in",
      ]) {
        await expect(
          registeredProvider!.create({ id: payload, name: "test" }),
        ).rejects.toThrow(/Invalid session id/);
      }
      expect(spawnCalls).toHaveLength(0);
    } finally {
      Bun.spawn = originalSpawn;
    }
  });
});
