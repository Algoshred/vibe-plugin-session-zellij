/**
 * @vibecontrols/vibe-plugin-session-zellij
 *
 * Zellij + ttyd session provider plugin for VibeControls Agent.
 * Implements the full SessionProvider interface (23 methods + 8 aliases) using
 * Zellij sessions for terminal session management and ttyd for
 * browser-accessible web terminals.
 *
 * Cross-platform: works on Windows, macOS, and Linux.
 * Uses `script` command for headless Zellij session creation.
 */

// No Subprocess import needed — we track PIDs only for restart resilience
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { Elysia } from "elysia";
import type {
  HostServices,
  ProfileContext,
  VibePlugin,
  VibePluginFactory,
} from "@vibecontrols/plugin-sdk/contract";
import { createLifecycleHooks } from "@vibecontrols/plugin-sdk/lifecycle";
import { TypedStore } from "@vibecontrols/plugin-sdk/storage";
import {
  findAvailablePort,
  gracefulKill,
  isProcessAlive,
  sleep,
} from "@vibecontrols/plugin-sdk/subprocess";
import { BoundLogger } from "@vibecontrols/plugin-sdk/log";
import { TelemetryEmitter } from "@vibecontrols/plugin-sdk/telemetry";
import { ProviderRegistry } from "@vibecontrols/plugin-sdk/providers";
import {
  installBinary,
  resolveBinary,
  type BinaryDownload,
  type ToolPlatform,
} from "@vibecontrols/plugin-sdk/install";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SessionStatus = "active" | "inactive" | "terminated" | "error";

interface SessionConfig {
  /** Optional external ID (e.g. backend UUID). If provided the plugin uses it instead of generating one. */
  id?: string;
  name: string;
  command?: string;
  workingDirectory?: string;
  environment?: Record<string, string>;
  shell?: string;
  size?: { cols: number; rows: number };
  projectId?: string;
  /** Optional provider-native session name. */
  externalName?: string;
}

interface SessionInfo {
  id: string;
  name: string;
  status: SessionStatus;
  provider: string;
  command?: string;
  workingDirectory?: string;
  pid?: number;
  projectId?: string;
  createdAt: string;
  updatedAt?: string;
  terminal?: TerminalInfo;
  metadata?: Record<string, unknown>;
}

interface TerminalInfo {
  url: string;
  port: number;
  pid: number;
  /** Transport host the terminal-server (ttyd) binds to. */
  host?: string;
  /** WebSocket path the terminal-server exposes. */
  wsPath?: string;
  /** WebSocket subprotocols the terminal-server speaks. */
  subprotocols?: string[];
}

interface HealthCheckResult {
  ok: boolean;
  sessions: number;
  terminals: number;
  message?: string;
}

interface SystemSessionInfo {
  id: string;
  name: string;
  windows: number;
  attached: boolean;
  createdAt?: string;
}

interface SystemTerminalInfo {
  pid: number;
  port: number;
  sessionId?: string;
}

interface SessionProvider {
  readonly name: string;
  create(config: SessionConfig): Promise<SessionInfo>;
  terminate(sessionId: string): Promise<void>;
  getInfo(sessionId: string): Promise<SessionInfo | null>;
  list(): Promise<SessionInfo[]>;
  sendCommand(sessionId: string, command: string): Promise<void>;
  sendKeys(sessionId: string, keys: string): Promise<void>;
  sendInterrupt(sessionId: string): Promise<void>;
  captureOutput(sessionId: string): Promise<string>;
  rename(sessionId: string, newName: string): Promise<void>;
  toggleMouse(sessionId: string): Promise<boolean>;
  getTerminationStatus(
    sessionId: string,
  ): Promise<{ terminated: boolean; exists: boolean }>;
  getTerminalInfo(sessionId: string): Promise<TerminalInfo | null>;
  startTerminal(sessionId: string, port?: number): Promise<TerminalInfo>;
  stopTerminal(sessionId: string): Promise<void>;
  listSystemSessions(): Promise<SystemSessionInfo[]>;
  listSystemTerminals(): Promise<SystemTerminalInfo[]>;
  bulkKillSystemSessions(
    sessionIds: string[],
  ): Promise<{ killed: number; failed: number }>;
  bulkKillSystemTerminals(
    pids: number[],
  ): Promise<{ killed: number; failed: number }>;
  healthCheck(): Promise<HealthCheckResult>;
  getSessionsByProject(projectId: string): Promise<SessionInfo[]>;
  cleanup(): Promise<{ cleaned: number }>;

  // Core agent interface aliases (routes use these names)
  get(sessionId: string): Promise<SessionInfo | null>;
  kill(sessionId: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  capture(
    sessionId: string,
    options?: { lines?: number; pane?: string },
  ): Promise<string>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  listSystem(): Promise<SystemSessionInfo[]>;
  killSystem(sessionId: string): Promise<void>;
  killSystemTerminal(pid: number): Promise<void>;

  // Optional capability & extended capture methods
  getCapabilities?(): SessionProviderCapabilities;
  getScrollback?(sessionId: string, lines: number): Promise<string>;
  searchOutput?(
    sessionId: string,
    pattern: string,
  ): Promise<Array<{ line: number; content: string }>>;

  // Optional orphan discovery / adoption
  discoverOrphans?(): Promise<OrphanSessionInfo[]>;
  adopt?(externalName: string, displayName?: string): Promise<SessionInfo>;
}

interface OrphanSessionInfo {
  externalName: string;
  provider: string;
  windows: number;
  attached: boolean;
  createdAt?: string;
}

interface SessionProviderCapabilities {
  provider: string;
  features: {
    mouse: boolean;
    resize: boolean;
    capture: boolean;
    webTerminal: boolean;
    splitPanes: boolean;
    tabs: boolean;
    scrollback: boolean;
    clipboard: boolean;
    search: boolean;
  };
  platform: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_NAME = "session-zellij";
const PLUGIN_PACKAGE_NAME = "@vibecontrols/vibe-plugin-session-zellij";
const PLUGIN_VERSION = getPluginVersion();
const PROVIDER_NAME = "session-zellij";
const STORAGE_NAMESPACE = "session-zellij";
const STORAGE_KEY_SESSIONS = "sessions";
const STORAGE_KEY_TERMINALS = "terminals";
const TTYD_BASE_PORT = 8081;
const TTYD_PORT_RANGE = 200;

// Terminal transport constants — the ttyd terminal-server binds loopback and
// exposes a WebSocket at /ws speaking the "tty" subprotocol. Consumers use
// these to construct the live transport URL.
const TERMINAL_HOST = "127.0.0.1";
const TERMINAL_WS_PATH = "/ws";
const TERMINAL_SUBPROTOCOLS = ["tty"];

// ---------------------------------------------------------------------------
// Provider-managed binaries (ttyd terminal-server + zellij multiplexer)
//
// This plugin OWNS downloading both binaries into the agent's binary cache
// (~/.boff/vibecontrols/tools) via the SDK installer. The thin agent never
// installs tools itself. Resolving by ABSOLUTE PATH (resolveBinary) sidesteps
// the PATH snapshot `Bun.which` takes at process start, which otherwise makes
// a mid-run install invisible to the running daemon (notably on Windows).
// ---------------------------------------------------------------------------

/**
 * Official ttyd release assets per platform. ttyd ships raw static binaries;
 * there is no macOS static binary upstream, so darwin-* is omitted (the
 * /prereqs/install falls back to a manual instruction there).
 */
const TTYD_DOWNLOADS: Partial<Record<ToolPlatform, BinaryDownload>> = {
  "linux-x64": {
    url: "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64",
    archive: "raw",
  },
  "linux-arm64": {
    url: "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.aarch64",
    archive: "raw",
  },
  "win32-x64": {
    url: "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.win32.exe",
    archive: "raw",
  },
};

/**
 * Official zellij release assets per platform. zellij ships tar.gz archives on
 * POSIX platforms and a zip with `zellij.exe` at the archive root on Windows.
 * Windows arm64 is omitted because upstream currently publishes x86_64 only.
 */
const ZELLIJ_DOWNLOADS: Partial<Record<ToolPlatform, BinaryDownload>> = {
  "linux-x64": {
    url: "https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz",
    archive: "tar.gz",
    binaryWithinArchive: "zellij",
  },
  "linux-arm64": {
    url: "https://github.com/zellij-org/zellij/releases/latest/download/zellij-aarch64-unknown-linux-musl.tar.gz",
    archive: "tar.gz",
    binaryWithinArchive: "zellij",
  },
  "darwin-x64": {
    url: "https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-apple-darwin.tar.gz",
    archive: "tar.gz",
    binaryWithinArchive: "zellij",
  },
  "darwin-arm64": {
    url: "https://github.com/zellij-org/zellij/releases/latest/download/zellij-aarch64-apple-darwin.tar.gz",
    archive: "tar.gz",
    binaryWithinArchive: "zellij",
  },
  "win32-x64": {
    url: "https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-pc-windows-msvc.zip",
    archive: "zip",
    binaryWithinArchive: "zellij.exe",
  },
};

async function ensureTtydBinary(log?: BoundLogger): Promise<string> {
  const existing = resolveBinary("ttyd");
  if (existing) return existing;

  log?.info("ttyd not found — attempting auto-install");
  try {
    const installed = await installBinary({
      name: "ttyd",
      downloads: TTYD_DOWNLOADS,
      versionMatcher: "ttyd version",
      log: {
        info: (msg) => log?.info(msg),
        warn: (msg) => log?.warn(msg),
        error: (msg) => log?.error(msg),
      },
    });
    log?.info("ttyd auto-installed", { path: installed });
    return installed;
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ttyd is not available and auto-install failed. ${manualInstructionFor("ttyd")}. Cause: ${cause}`,
      { cause: err },
    );
  }
}

async function ensureZellijBinary(log?: BoundLogger): Promise<string> {
  const existing = resolveBinary("zellij");
  if (existing) return existing;

  log?.info("zellij not found — attempting auto-install");
  try {
    const installed = await installBinary({
      name: "zellij",
      downloads: ZELLIJ_DOWNLOADS,
      versionMatcher: "zellij",
      log: {
        info: (msg) => log?.info(msg),
        warn: (msg) => log?.warn(msg),
        error: (msg) => log?.error(msg),
      },
    });
    log?.info("zellij auto-installed", { path: installed });
    return installed;
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `zellij is not available and auto-install failed. ${manualInstructionFor("zellij")}. Cause: ${cause}`,
      { cause: err },
    );
  }
}

function resolveZellijCmd(): string {
  return resolveBinary("zellij") ?? "zellij";
}

// ---------------------------------------------------------------------------
// Zellij session info parsed from `zellij list-sessions`
// ---------------------------------------------------------------------------

interface ZellijSessionListEntry {
  name: string;
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a short random hex ID (8 chars) for session identifiers.
 */
function generateId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Check if we are running on Windows.
 */
function isWindows(): boolean {
  return process.platform === "win32";
}

function getPluginVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10 && dir && dir !== dirname(dir); i++) {
      const pkgPath = joinPath(dir, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
            name?: string;
            version?: string;
          };
          if (
            pkg.name === PLUGIN_PACKAGE_NAME &&
            typeof pkg.version === "string"
          ) {
            return pkg.version;
          }
        } catch {
          /* malformed package.json — keep walking up */
        }
      }
      dir = dirname(dir);
    }
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

/**
 * Strip ANSI escape codes from a string.
 * Zellij's CLI output always includes color codes even with NO_COLOR.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

/**
 * Execute a zellij command and return its stdout. Throws on non-zero exit.
 */
function zellijExec(args: string[]): string {
  const result = Bun.spawnSync([resolveZellijCmd(), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(`zellij exited with code ${result.exitCode}: ${stderr}`);
  }
  return result.stdout.toString("utf-8").trimEnd();
}

/**
 * Execute a zellij command, returning true on success, false on failure.
 * Does not throw.
 */
function zellijExecSilent(args: string[]): boolean {
  try {
    const result = Bun.spawnSync([resolveZellijCmd(), ...args], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Execute a `zellij -s <session> action <actionArgs>` command and return stdout.
 * Throws on non-zero exit.
 */
function zellijActionExec(sessionName: string, actionArgs: string[]): string {
  return zellijExec(["-s", sessionName, "action", ...actionArgs]);
}

/**
 * Execute a `zellij -s <session> action <actionArgs>` silently.
 * Returns true on success.
 */
function zellijActionExecSilent(
  sessionName: string,
  actionArgs: string[],
): boolean {
  return zellijExecSilent(["-s", sessionName, "action", ...actionArgs]);
}

/**
 * Check if a zellij session exists by parsing `zellij list-sessions` output.
 */
function zellijSessionExists(sessionName: string): boolean {
  try {
    const raw = stripAnsi(zellijExec(["list-sessions"]));
    if (!raw) return false;
    for (const line of raw.split("\n")) {
      const name = line.trim().split(/\s+/)[0];
      if (name === sessionName) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Parse `zellij list-sessions` output into an array of session entries.
 * Output format: `session-name [Created Xs ago]` or similar.
 */
function listZellijSessions(): ZellijSessionListEntry[] {
  try {
    const raw = stripAnsi(zellijExec(["list-sessions"]));
    if (!raw) return [];

    const entries: ZellijSessionListEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Extract session name (first token before whitespace or bracket)
      const nameMatch = trimmed.match(/^(\S+)/);
      if (!nameMatch) continue;

      const name = nameMatch[1];

      // Try to extract creation time info from bracketed content
      const bracketMatch = trimmed.match(/\[Created\s+(.+?)\s+ago\]/i);
      const createdAt = bracketMatch ? bracketMatch[1] : undefined;

      entries.push({ name, createdAt });
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * Get the current ISO timestamp.
 */
function nowISO(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// ZellijSessionProvider
// ---------------------------------------------------------------------------

interface PersistedTerminal {
  pid: number;
  port: number;
}

class ZellijSessionProvider implements SessionProvider {
  readonly name = PROVIDER_NAME;

  /** Logger — bound to plugin source; no-op until init() supplies host logger. */
  private log: BoundLogger = new BoundLogger(undefined, PLUGIN_NAME);

  /** TypedStore handles — assigned in init() once host storage is available. */
  private sessionsStore: TypedStore<SessionInfo[]> | null = null;
  private terminalsStore: TypedStore<Record<string, PersistedTerminal>> | null =
    null;

  /** In-memory map of ttyd PIDs keyed by session ID. */
  private ttydPids: Map<string, number> = new Map();

  /** In-memory map of ttyd port assignments keyed by session ID. */
  private ttydPorts: Map<string, number> = new Map();

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Initialise the provider with host services. Called from onServerStart.
   */
  async init(services: HostServices): Promise<void> {
    this.log = new BoundLogger(services.logger, PLUGIN_NAME);

    if (services.storage) {
      this.sessionsStore = new TypedStore<SessionInfo[]>(
        services.storage,
        STORAGE_NAMESPACE,
        STORAGE_KEY_SESSIONS,
        services.logger,
        PLUGIN_NAME,
      );
      this.terminalsStore = new TypedStore<Record<string, PersistedTerminal>>(
        services.storage,
        STORAGE_NAMESPACE,
        STORAGE_KEY_TERMINALS,
        services.logger,
        PLUGIN_NAME,
      );
    }

    this.log.info("ZellijSessionProvider initialising", {
      provider: this.name,
    });

    // Ensure zellij is installed (auto-install if missing)
    await this.ensureDependencies();

    // Verify zellij is available
    try {
      const version = zellijExec(["--version"]);
      this.log.info("zellij detected", { version });
    } catch {
      this.log.error(
        "zellij is not installed or not in PATH — session provider will not function",
      );
    }

    // Reconcile persisted sessions against actual zellij state
    await this.reconcileSessions();

    this.log.info("ZellijSessionProvider ready");
  }

  /**
   * Graceful shutdown: stop all ttyd terminals.
   */
  async shutdown(context?: { reason: "reload" | "shutdown" }): Promise<void> {
    if (context?.reason === "reload") {
      this.log.info(
        "Hot-reload: preserving zellij sessions and ttyd processes",
      );
      await this.persistTerminals();
      this.ttydPids.clear();
      this.ttydPorts.clear();
      return;
    }

    this.log.info("ZellijSessionProvider shutting down — stopping terminals");
    const stopPromises: Promise<void>[] = [];
    for (const [sessionId] of this.ttydPids) {
      stopPromises.push(this.stopTerminal(sessionId));
    }
    await Promise.allSettled(stopPromises);
    try {
      await this.terminalsStore?.delete();
    } catch {
      /* ignore */
    }
    this.log.info("ZellijSessionProvider shutdown complete");
  }

  /**
   * Full teardown for `vibe nuke`. Force-reaps every ttyd (terminal-server)
   * process and every zellij session this plugin spawned, then clears the
   * plugin's persisted storage namespace. Returns the list of process kinds
   * actually reaped. Runs while the daemon is still up, so the in-memory
   * process maps are reachable.
   */
  async nuke(): Promise<string[]> {
    const reaped: string[] = [];

    // 1. Stop all tracked ttyd terminal-server processes (graceful), reusing
    //    the existing per-session teardown so storage records are cleaned too.
    const ttydCount = this.ttydPids.size;
    const stopPromises: Promise<void>[] = [];
    for (const [sessionId] of this.ttydPids) {
      stopPromises.push(this.stopTerminal(sessionId));
    }
    await Promise.allSettled(stopPromises);

    // 2. Belt-and-braces: force-reap any ttyd PIDs still alive (a graceful
    //    stop may have left a straggler).
    const killPromises: Promise<void>[] = [];
    for (const pid of this.ttydPids.values()) {
      if (isProcessAlive(pid)) {
        killPromises.push(gracefulKill(pid).catch(() => undefined));
      }
    }
    await Promise.allSettled(killPromises);
    this.ttydPids.clear();
    this.ttydPorts.clear();
    if (ttydCount > 0) {
      reaped.push(`${ttydCount} ttyd terminal-server process(es)`);
    }

    // 3. Kill + delete every zellij session this plugin created (tracked in
    //    storage). Only reap our own (non-terminated) sessions — never touch
    //    sessions we don't own.
    let zellijKilled = 0;
    const sessions = await this.loadSessions();
    for (const session of sessions) {
      if (session.status === "terminated") continue;
      const zellijSessionName = this.getZellijSessionName(session);
      if (zellijSessionExists(zellijSessionName)) {
        zellijExecSilent(["kill-session", zellijSessionName]);
        zellijExecSilent(["delete-session", zellijSessionName]);
        zellijKilled++;
      }
    }
    if (zellijKilled > 0) {
      reaped.push(`${zellijKilled} zellij session(s)`);
    }

    // 4. Clear the plugin's persisted storage namespace.
    try {
      await this.sessionsStore?.delete();
    } catch {
      /* ignore */
    }
    try {
      await this.terminalsStore?.delete();
    } catch {
      /* ignore */
    }
    reaped.push("session-zellij storage");

    this.log.info("ZellijSessionProvider nuke complete", {
      ttydReaped: ttydCount,
      zellijKilled,
    });
    return reaped;
  }

  // -----------------------------------------------------------------------
  // SessionProvider — create / terminate / getInfo / list
  // -----------------------------------------------------------------------

  async create(config: SessionConfig): Promise<SessionInfo> {
    // Attach-or-error on explicit externalName.
    if (config.externalName) {
      const target = config.externalName;
      if (
        target.length === 0 ||
        target.length > 128 ||
        /[\0\r\n\s]/.test(target)
      ) {
        throw new Error(`Invalid externalName: ${target}`);
      }
      if (zellijSessionExists(target)) {
        this.log.info("create(): attaching to existing zellij session", {
          target,
        });
        return this.adopt(target, config.name);
      }
      throw new Error(
        `No zellij session named "${target}" — drop externalName to create a new one`,
      );
    }
    const id = config.id || generateId();
    const zellijSessionName = `vibe-${id.substring(0, 8)}`;
    const now = nowISO();

    this.log.info("Creating zellij session", {
      id,
      name: config.name,
      zellijSessionName,
    });

    // Spawn zellij session headlessly using `script` to provide a PTY.
    // Zellij requires a PTY to start; `script` provides one in headless mode.
    try {
      const zellijCmd = await ensureZellijBinary(this.log);
      if (isWindows()) {
        // On Windows, spawn zellij directly (no script command)
        Bun.spawn([zellijCmd, "-s", zellijSessionName], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
      } else {
        // Use sh -c to redirect stdin from /dev/null. The `script` command
        // needs a PTY but stdin must come from /dev/null for headless mode.
        Bun.spawn(
          [
            "sh",
            "-c",
            `script -qfc "${zellijCmd} -s ${zellijSessionName}" /dev/null </dev/null >/dev/null 2>&1`,
          ],
          {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          },
        );
      }
    } catch (err) {
      this.log.error("Failed to spawn zellij session", {
        id,
        error: String(err),
      });
      throw new Error(`Failed to create zellij session: ${err}`, {
        cause: err,
      });
    }

    // Wait for zellij to start and create the session
    await sleep(3000);

    // Verify session exists
    if (!zellijSessionExists(zellijSessionName)) {
      // Retry once with a shorter wait
      await sleep(2000);
      if (!zellijSessionExists(zellijSessionName)) {
        throw new Error(
          `Zellij session '${zellijSessionName}' was not created — ` +
            "zellij may not be running or the session failed to start",
        );
      }
    }

    // Apply working directory by sending cd command
    if (config.workingDirectory) {
      const escaped = config.workingDirectory.replace(/'/g, "'\\''");
      zellijActionExecSilent(zellijSessionName, [
        "write-chars",
        `cd '${escaped}'`,
      ]);
      zellijActionExecSilent(zellijSessionName, ["write", "10"]); // Enter
      await sleep(200);
    }

    // Apply environment variables by sending export commands
    if (config.environment) {
      for (const [key, value] of Object.entries(config.environment)) {
        const escaped = value.replace(/'/g, "'\\''");
        zellijActionExecSilent(zellijSessionName, [
          "write-chars",
          `export ${key}='${escaped}'`,
        ]);
        zellijActionExecSilent(zellijSessionName, ["write", "10"]); // Enter
      }
      // Small delay for environment to settle
      await sleep(200);
    }

    // If an initial command is given, send it
    if (config.command) {
      zellijActionExecSilent(zellijSessionName, [
        "write-chars",
        config.command,
      ]);
      zellijActionExecSilent(zellijSessionName, ["write", "10"]); // Enter
    }

    const info: SessionInfo = {
      id,
      name: config.name,
      status: "active",
      provider: this.name,
      command: config.command,
      workingDirectory: config.workingDirectory,
      pid: undefined,
      projectId: config.projectId,
      createdAt: now,
      updatedAt: now,
      metadata: {
        zellijSessionName,
        shell: config.shell,
        size: config.size,
      },
    };

    await this.saveSession(info);

    this.log.info("Zellij session created", {
      id,
      zellijSessionName,
    });
    return info;
  }

  async terminate(sessionId: string): Promise<void> {
    const session = await this.getInfo(sessionId);
    if (!session) {
      this.log.warn("Terminate called for unknown session", { sessionId });
      return;
    }

    const zellijSessionName = this.getZellijSessionName(session);
    this.log.info("Terminating zellij session", {
      sessionId,
      zellijSessionName,
    });

    // Stop terminal first if running
    if (this.ttydPids.has(sessionId)) {
      await this.stopTerminal(sessionId);
    }

    // Kill the zellij session
    zellijExecSilent(["kill-session", zellijSessionName]);
    // Also delete the session to clean up
    zellijExecSilent(["delete-session", zellijSessionName]);

    // Update stored state
    session.status = "terminated";
    session.updatedAt = nowISO();
    session.terminal = undefined;
    await this.saveSession(session);

    this.log.info("Zellij session terminated", { sessionId });
  }

  async getInfo(sessionId: string): Promise<SessionInfo | null> {
    const sessions = await this.loadSessions();
    const session = sessions.find((s) => s.id === sessionId) ?? null;

    if (session) {
      // Refresh live status from zellij
      const zellijSessionName = this.getZellijSessionName(session);
      const exists = zellijSessionExists(zellijSessionName);
      if (!exists && session.status === "active") {
        session.status = "inactive";
        session.updatedAt = nowISO();
        await this.saveSession(session);
      } else if (exists && session.status === "inactive") {
        session.status = "active";
        session.updatedAt = nowISO();
        await this.saveSession(session);
      }

      // Attach terminal info if running
      const termInfo = this.getRunningTerminalInfo(sessionId);
      if (termInfo) {
        session.terminal = termInfo;
      }
    }

    return session;
  }

  async list(): Promise<SessionInfo[]> {
    const sessions = await this.loadSessions();
    // Refresh statuses
    for (const session of sessions) {
      if (session.status === "terminated") continue;
      const zellijSessionName = this.getZellijSessionName(session);
      const exists = zellijSessionExists(zellijSessionName);
      if (!exists && session.status === "active") {
        session.status = "inactive";
        session.updatedAt = nowISO();
      } else if (exists && session.status !== "active") {
        session.status = "active";
        session.updatedAt = nowISO();
      }
      // Attach terminal info
      const termInfo = this.getRunningTerminalInfo(session.id);
      if (termInfo) {
        session.terminal = termInfo;
      }
    }
    await this.saveSessions(sessions);
    return sessions;
  }

  // -----------------------------------------------------------------------
  // SessionProvider — command / keys / interrupt / capture
  // -----------------------------------------------------------------------

  async sendCommand(sessionId: string, command: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    const zellijSessionName = this.getZellijSessionName(session);

    this.log.debug("Sending command", { sessionId, command });
    try {
      zellijActionExec(zellijSessionName, ["write-chars", command]);
      zellijActionExec(zellijSessionName, ["write", "10"]); // Enter byte
    } catch (err) {
      this.log.error("Failed to send command", {
        sessionId,
        error: String(err),
      });
      throw new Error(
        `Failed to send command to session ${sessionId}: ${err}`,
        { cause: err },
      );
    }
  }

  async sendKeys(sessionId: string, keys: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    const zellijSessionName = this.getZellijSessionName(session);

    this.log.debug("Sending keys", { sessionId, keys });
    try {
      zellijActionExec(zellijSessionName, ["write-chars", keys]);
    } catch (err) {
      this.log.error("Failed to send keys", {
        sessionId,
        error: String(err),
      });
      throw new Error(`Failed to send keys to session ${sessionId}: ${err}`, {
        cause: err,
      });
    }
  }

  async sendInterrupt(sessionId: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    const zellijSessionName = this.getZellijSessionName(session);

    this.log.debug("Sending interrupt (Ctrl+C)", { sessionId });
    try {
      // Ctrl+C is byte 3
      zellijActionExec(zellijSessionName, ["write", "3"]);
    } catch (err) {
      this.log.error("Failed to send interrupt", {
        sessionId,
        error: String(err),
      });
      throw new Error(
        `Failed to send interrupt to session ${sessionId}: ${err}`,
        { cause: err },
      );
    }
  }

  async captureOutput(sessionId: string): Promise<string> {
    const session = await this.requireSession(sessionId);
    const zellijSessionName = this.getZellijSessionName(session);

    this.log.debug("Capturing output", { sessionId });

    // Use dump-screen to capture the visible terminal output to a temp file
    const tmpFile = joinPath(
      tmpdir(),
      `vibe-zellij-capture-${sessionId}-${Date.now()}.txt`,
    );

    try {
      zellijActionExec(zellijSessionName, ["dump-screen", "--path", tmpFile]);

      // Read the dumped file
      const file = Bun.file(tmpFile);
      const exists = await file.exists();
      if (!exists) {
        throw new Error("dump-screen did not create output file");
      }

      const output = await file.text();

      // Clean up temp file
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(tmpFile);
      } catch {
        // Best-effort cleanup
      }

      return output;
    } catch (err) {
      this.log.error("Failed to capture output", {
        sessionId,
        error: String(err),
      });
      throw new Error(
        `Failed to capture output from session ${sessionId}: ${err}`,
        { cause: err },
      );
    }
  }

  // -----------------------------------------------------------------------
  // SessionProvider — rename / toggleMouse / getTerminationStatus
  // -----------------------------------------------------------------------

  async rename(sessionId: string, newName: string): Promise<void> {
    const session = await this.requireSession(sessionId);

    this.log.info("Renaming session", {
      sessionId,
      from: session.name,
      to: newName,
    });

    try {
      // Rename the display name in our records
      session.name = newName;
      session.updatedAt = nowISO();
      await this.saveSession(session);
    } catch (err) {
      this.log.error("Failed to rename session", {
        sessionId,
        error: String(err),
      });
      throw new Error(`Failed to rename session ${sessionId}: ${err}`, {
        cause: err,
      });
    }

    // Also try to rename the zellij session for cosmetic purposes
    const zellijSessionName = this.getZellijSessionName(session);
    const newZellijName = `vibe-${session.id}`;
    zellijActionExecSilent(zellijSessionName, [
      "rename-session",
      newZellijName,
    ]);
  }

  async toggleMouse(_sessionId: string): Promise<boolean> {
    // Zellij always has mouse support enabled — this is a no-op.
    // Return true to indicate mouse is on.
    this.log.debug("toggleMouse is a no-op for zellij (always enabled)", {
      sessionId: _sessionId,
    });
    return true;
  }

  async getTerminationStatus(
    sessionId: string,
  ): Promise<{ terminated: boolean; exists: boolean }> {
    const sessions = await this.loadSessions();
    const session = sessions.find((s) => s.id === sessionId);

    if (!session) {
      return { terminated: true, exists: false };
    }

    const zellijSessionName = this.getZellijSessionName(session);
    const exists = zellijSessionExists(zellijSessionName);

    return {
      terminated: session.status === "terminated" || !exists,
      exists,
    };
  }

  // -----------------------------------------------------------------------
  // SessionProvider — terminal (ttyd) management
  // -----------------------------------------------------------------------

  async getTerminalInfo(sessionId: string): Promise<TerminalInfo | null> {
    return this.getRunningTerminalInfo(sessionId);
  }

  async startTerminal(sessionId: string, port?: number): Promise<TerminalInfo> {
    const session = await this.requireSession(sessionId);
    const zellijSessionName = this.getZellijSessionName(session);

    // If already running, return existing info
    const existing = this.getRunningTerminalInfo(sessionId);
    if (existing) {
      this.log.debug("Terminal already running", { sessionId, ...existing });
      return existing;
    }

    // Find an available port, scanning ABOVE the highest port we've already
    // handed out. `findAvailablePort` only OS-probes free ports — during the
    // window between assigning a port and ttyd actually binding it (the sleep
    // below), a concurrent/back-to-back start would otherwise re-pick the same
    // not-yet-bound port and one ttyd would die on bind. Excluding in-flight
    // ports makes per-session ports collision-free.
    const inUsePorts = [...this.ttydPorts.values()];
    const scanStart = inUsePorts.length
      ? Math.max(TTYD_BASE_PORT, Math.max(...inUsePorts) + 1)
      : TTYD_BASE_PORT;
    const assignedPort =
      port ?? (await findAvailablePort(scanStart, TTYD_PORT_RANGE));

    this.log.info("Starting ttyd terminal", {
      sessionId,
      zellijSessionName,
      port: assignedPort,
    });

    // Spawn ttyd with `zellij attach <session>` — this attaches to the actual
    // zellij session, so the user gets the real zellij environment ($ZELLIJ is
    // set by zellij itself). This mirrors how the tmux plugin uses
    // `ttyd tmux attach -t <session>`.
    //
    // Build the ttyd environment: strip other providers' vars so the shell
    // inside zellij doesn't inherit stale identifiers from the agent's env.
    const ttydEnv: Record<string, string | undefined> = { ...process.env };
    ttydEnv.VIBECONTROLS_PROVIDER = "zellij";

    const otherProviderVars: Record<string, string[]> = {
      tmux: ["TMUX", "TMUX_PANE", "TMUX_PLUGIN_MANAGER_PATH"],
      wezterm: ["WEZTERM_PANE", "WEZTERM_UNIX_SOCKET"],
      screen: ["STY", "WINDOW"],
    };
    for (const vars of Object.values(otherProviderVars)) {
      for (const v of vars) {
        if (v in ttydEnv) delete ttydEnv[v];
      }
    }

    const ttydCmd = await ensureTtydBinary(this.log);
    const zellijCmd = await ensureZellijBinary(this.log);
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(
        [
          ttydCmd,
          "-t",
          "fontSize=14",
          "-t",
          `theme={"background":"#1e1e1e","foreground":"#cccccc"}`,
          "--writable",
          "--port",
          String(assignedPort),
          zellijCmd,
          "attach",
          zellijSessionName,
        ],
        {
          stdout: "ignore",
          // Pipe stderr so a ttyd that exits on launch (port already bound,
          // missing mux target, bad binary) is DIAGNOSABLE instead of being
          // stored with a soon-dead PID that only surfaces downstream as the
          // opaque "Terminal not running for this session". Drained (capped)
          // below so the pipe never blocks a long-lived ttyd.
          stderr: "pipe",
          stdin: "ignore",
          env: ttydEnv as Record<string, string>,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/ENOENT|no such file|not found|uv_spawn/i.test(message)) {
        throw new Error(
          `zellij terminal could not spawn ttyd="${ttydCmd}" zellij="${zellijCmd}". Cause: ${message}`,
          { cause: err },
        );
      }
      throw err;
    }

    if (!child.pid) {
      throw new Error("Failed to start ttyd — no PID returned");
    }

    let ttydStderr = "";
    const stderrStream = child.stderr as ReadableStream<Uint8Array> | undefined;
    if (stderrStream && typeof stderrStream.getReader === "function") {
      void (async () => {
        try {
          const reader = stderrStream.getReader();
          const dec = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (ttydStderr.length < 4096)
              ttydStderr += dec.decode(value, { stream: true });
          }
        } catch {
          // stream closed/cancelled — nothing to capture
        }
      })();
    }

    // Give ttyd a moment to bind the port, then confirm it actually survived.
    await sleep(500);
    if (child.exitCode !== null || !isProcessAlive(child.pid)) {
      const detail = ttydStderr.trim().slice(0, 300) || "no stderr captured";
      this.log.error("ttyd exited immediately after launch", {
        sessionId,
        port: assignedPort,
        exitCode: child.exitCode,
        stderr: detail,
      });
      throw new Error(
        `ttyd exited immediately (code ${child.exitCode ?? "unknown"}) on port ${assignedPort}: ${detail}`,
      );
    }

    // Store references
    this.ttydPids.set(sessionId, child.pid);
    this.ttydPorts.set(sessionId, assignedPort);
    await this.persistTerminals();

    const terminalInfo: TerminalInfo = {
      url: `http://localhost:${assignedPort}`,
      port: assignedPort,
      pid: child.pid,
      host: TERMINAL_HOST,
      wsPath: TERMINAL_WS_PATH,
      subprotocols: TERMINAL_SUBPROTOCOLS,
    };

    // Update session record with terminal info
    session.terminal = terminalInfo;
    session.updatedAt = nowISO();
    await this.saveSession(session);

    this.log.info("ttyd terminal started", {
      sessionId,
      port: assignedPort,
      pid: child.pid,
    });

    return terminalInfo;
  }

  async stopTerminal(sessionId: string): Promise<void> {
    const pid = this.ttydPids.get(sessionId);
    if (!pid) {
      this.log.debug("No ttyd process found for session", { sessionId });
      return;
    }

    this.log.info("Stopping ttyd terminal", {
      sessionId,
      pid,
    });

    await gracefulKill(pid);

    this.ttydPids.delete(sessionId);
    this.ttydPorts.delete(sessionId);
    await this.persistTerminals();

    // Clear terminal from session record
    const session = await this.getInfo(sessionId);
    if (session) {
      session.terminal = undefined;
      session.updatedAt = nowISO();
      await this.saveSession(session);
    }

    this.log.info("ttyd terminal stopped", { sessionId });
  }

  // -----------------------------------------------------------------------
  // SessionProvider — system-level listing and bulk operations
  // -----------------------------------------------------------------------

  async listSystemSessions(): Promise<SystemSessionInfo[]> {
    try {
      const zellijSessions = listZellijSessions();
      if (zellijSessions.length === 0) return [];

      const results: SystemSessionInfo[] = [];
      for (const entry of zellijSessions) {
        results.push({
          id: entry.name,
          name: entry.name,
          windows: 1, // Zellij doesn't expose window count in list-sessions
          attached: false, // Zellij list-sessions doesn't clearly expose attachment state in text output
          createdAt: entry.createdAt,
        });
      }

      return results;
    } catch {
      return [];
    }
  }

  async listSystemTerminals(): Promise<SystemTerminalInfo[]> {
    const terminals: SystemTerminalInfo[] = [];

    for (const [sessionId, pid] of this.ttydPids) {
      const port = this.ttydPorts.get(sessionId);
      if (pid && port !== undefined) {
        terminals.push({
          pid,
          port,
          sessionId,
        });
      }
    }

    // Also look for any orphaned ttyd processes via pgrep (Unix only)
    if (!isWindows()) {
      try {
        const pgrepResult = Bun.spawnSync(["pgrep", "-a", "ttyd"], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        });
        const raw = pgrepResult.stdout.toString().trim();

        if (raw) {
          for (const line of raw.split("\n")) {
            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[0] ?? "0", 10);
            if (!pid) continue;

            // Skip already-tracked processes
            if ([...this.ttydPids.values()].includes(pid)) continue;

            // Try to extract port from command line
            const portIdx = parts.indexOf("--port");
            const port =
              portIdx !== -1 ? parseInt(parts[portIdx + 1] ?? "0", 10) : 0;

            terminals.push({ pid, port: port || 0 });
          }
        }
      } catch {
        // pgrep returns non-zero when no processes found — that's fine
      }
    }

    return terminals;
  }

  async bulkKillSystemSessions(
    sessionIds: string[],
  ): Promise<{ killed: number; failed: number }> {
    let killed = 0;
    let failed = 0;

    // sessionIds here are session names when coming from listSystemSessions
    for (const sessionName of sessionIds) {
      const killOk = zellijExecSilent(["kill-session", sessionName]);
      // Also delete the session to fully clean up
      zellijExecSilent(["delete-session", sessionName]);

      if (killOk) {
        killed++;
      } else {
        failed++;
      }
    }

    this.log.info("Bulk kill system sessions", { killed, failed });
    return { killed, failed };
  }

  async bulkKillSystemTerminals(
    pids: number[],
  ): Promise<{ killed: number; failed: number }> {
    let killed = 0;
    let failed = 0;

    const killPromises = pids.map(async (pid) => {
      try {
        await gracefulKill(pid);
        killed++;

        // Remove from tracked processes if present
        for (const [sessionId, trackedPid] of this.ttydPids) {
          if (trackedPid === pid) {
            this.ttydPids.delete(sessionId);
            this.ttydPorts.delete(sessionId);
            break;
          }
        }
      } catch {
        failed++;
      }
    });

    await Promise.allSettled(killPromises);

    this.log.info("Bulk kill system terminals", { killed, failed });
    return { killed, failed };
  }

  // -----------------------------------------------------------------------
  // SessionProvider — health / project filter / cleanup
  // -----------------------------------------------------------------------

  async healthCheck(): Promise<HealthCheckResult> {
    let zellijOk: boolean;
    let zellijVersion: string;
    let sessionCount = 0;
    const terminalCount = this.ttydPids.size;

    try {
      zellijVersion = zellijExec(["--version"]);
      zellijOk = true;
    } catch {
      return {
        ok: false,
        sessions: 0,
        terminals: terminalCount,
        message: "zellij is not available",
      };
    }

    try {
      const sysSessions = await this.listSystemSessions();
      sessionCount = sysSessions.length;
    } catch {
      // Ignore — zero sessions
    }

    // Check ttyd availability via resolveBinary — prefers the provider-managed
    // cache (absolute path, immune to the Bun.which PATH snapshot), then PATH.
    const ttydOk = resolveBinary("ttyd") !== null;

    const messages: string[] = [zellijVersion];
    if (!ttydOk) {
      messages.push("ttyd not found — web terminals unavailable");
    }

    return {
      ok: zellijOk,
      sessions: sessionCount,
      terminals: terminalCount,
      message: messages.join("; "),
    };
  }

  async getSessionsByProject(projectId: string): Promise<SessionInfo[]> {
    const sessions = await this.list();
    return sessions.filter((s) => s.projectId === projectId);
  }

  async cleanup(): Promise<{ cleaned: number }> {
    this.log.info("Running cleanup");

    const sessions = await this.loadSessions();
    let cleaned = 0;
    const kept: SessionInfo[] = [];

    for (const session of sessions) {
      const zellijSessionName = this.getZellijSessionName(session);
      const exists = zellijSessionExists(zellijSessionName);

      if (session.status === "terminated" || !exists) {
        // Stop terminal if somehow still running
        if (this.ttydPids.has(session.id)) {
          await this.stopTerminal(session.id);
        }

        // Kill the zellij session if it still exists but session was marked terminated
        if (exists && session.status === "terminated") {
          zellijExecSilent(["kill-session", zellijSessionName]);
          zellijExecSilent(["delete-session", zellijSessionName]);
        }

        cleaned++;
        this.log.debug("Cleaned session", {
          id: session.id,
          name: session.name,
        });
      } else {
        kept.push(session);
      }
    }

    await this.saveSessions(kept);

    this.log.info("Cleanup complete", { cleaned, remaining: kept.length });
    return { cleaned };
  }

  // -----------------------------------------------------------------------
  // Core agent interface aliases
  // The core SessionProvider interface uses these names; delegate to our
  // implementations so the session routes work correctly.
  // -----------------------------------------------------------------------

  async get(sessionId: string): Promise<SessionInfo | null> {
    return this.getInfo(sessionId);
  }

  async kill(sessionId: string): Promise<void> {
    return this.terminate(sessionId);
  }

  async interrupt(sessionId: string): Promise<void> {
    return this.sendInterrupt(sessionId);
  }

  async capture(sessionId: string): Promise<string> {
    return this.captureOutput(sessionId);
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    const session = await this.requireSession(sessionId);
    const zellijSessionName = this.getZellijSessionName(session);

    // Zellij CLI does not have a direct set-size command for panes.
    // The pane will auto-size based on the terminal dimensions.
    this.log.warn(
      "resize: Zellij CLI does not support absolute pane resize. " +
        "The pane will auto-size based on the terminal dimensions.",
      {
        sessionId,
        zellijSessionName,
        requestedCols: cols,
        requestedRows: rows,
      },
    );
  }

  async listSystem(): Promise<SystemSessionInfo[]> {
    return this.listSystemSessions();
  }

  async killSystem(sessionId: string): Promise<void> {
    // sessionId is a session name from listSystemSessions
    zellijExecSilent(["kill-session", sessionId]);
    zellijExecSilent(["delete-session", sessionId]);
  }

  async killSystemTerminal(pid: number): Promise<void> {
    await gracefulKill(pid);
    // Remove from tracked processes if present
    for (const [sessionId, trackedPid] of this.ttydPids) {
      if (trackedPid === pid) {
        this.ttydPids.delete(sessionId);
        this.ttydPorts.delete(sessionId);
        break;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Orphan discovery & adoption
  // -----------------------------------------------------------------------

  async discoverOrphans(): Promise<OrphanSessionInfo[]> {
    const known = new Set(
      (await this.loadSessions())
        .filter((s) => s.status !== "terminated")
        .map((s) => this.getZellijSessionName(s)),
    );
    const sys = await this.listSystemSessions();
    return sys
      .filter((s) => s.name.startsWith("vibe-") && !known.has(s.name))
      .map((s) => ({
        externalName: s.name,
        provider: "zellij",
        windows: s.windows,
        attached: s.attached,
        createdAt: s.createdAt,
      }));
  }

  async adopt(
    externalName: string,
    displayName?: string,
  ): Promise<SessionInfo> {
    if (!externalName.startsWith("vibe-")) {
      throw new Error(
        `Refusing to adopt zellij session "${externalName}" — only vibe-* sessions are adoptable`,
      );
    }
    if (!zellijSessionExists(externalName)) {
      throw new Error(`Zellij session "${externalName}" does not exist`);
    }
    const id = externalName.slice("vibe-".length) || externalName;
    const existing = (await this.loadSessions()).find((s) => s.id === id);
    if (existing) {
      if (!this.ttydPids.has(id)) {
        try {
          await this.startTerminal(id);
        } catch {
          /* best-effort */
        }
      }
      return (await this.get(id)) ?? existing;
    }
    const now = nowISO();
    const info: SessionInfo = {
      id,
      name: displayName || externalName,
      status: "active",
      provider: this.name,
      createdAt: now,
      updatedAt: now,
      metadata: {
        zellijSessionName: externalName,
        adopted: true,
      },
    };
    await this.saveSession(info);
    try {
      info.terminal = await this.startTerminal(id);
      await this.saveSession(info);
    } catch {
      /* best-effort */
    }
    return info;
  }

  // -----------------------------------------------------------------------
  // Capability & extended capture methods
  // -----------------------------------------------------------------------

  getCapabilities(): SessionProviderCapabilities {
    return {
      provider: "zellij",
      features: {
        mouse: true,
        resize: true,
        capture: true,
        webTerminal: true,
        splitPanes: true,
        tabs: true,
        scrollback: true,
        clipboard: false,
        search: true,
      },
      platform: ["linux", "macos", "windows"],
    };
  }

  async getScrollback(sessionId: string, lines: number): Promise<string> {
    const session = await this.requireSession(sessionId);
    const zellijSessionName = this.getZellijSessionName(session);

    this.log.debug("Getting scrollback", { sessionId, lines });

    // Zellij dump-screen captures the visible terminal; for scrollback we use
    // dump-screen with --full flag (captures full scrollback buffer)
    const tmpFile = joinPath(
      tmpdir(),
      `vibe-zellij-scrollback-${sessionId}-${Date.now()}.txt`,
    );

    try {
      zellijActionExec(zellijSessionName, [
        "dump-screen",
        "--path",
        tmpFile,
        "--full",
      ]);

      const file = Bun.file(tmpFile);
      const exists = await file.exists();
      if (!exists) {
        throw new Error("dump-screen did not create output file");
      }

      const output = await file.text();

      // Clean up temp file
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors
      }

      // Return only the last N lines
      const allLines = output.split("\n");
      const sliced = allLines.slice(-lines);
      return sliced.join("\n");
    } catch (err) {
      this.log.error("Failed to get scrollback", {
        sessionId,
        error: String(err),
      });
      throw new Error(
        `Failed to get scrollback for session ${sessionId}: ${err}`,
        { cause: err },
      );
    }
  }

  async searchOutput(
    sessionId: string,
    pattern: string,
  ): Promise<Array<{ line: number; content: string }>> {
    // Capture scrollback and search through it
    const scrollback = await this.getScrollback(sessionId, 10000);
    const lines = scrollback.split("\n");
    const results: Array<{ line: number; content: string }> = [];

    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i] ?? "")) {
        results.push({ line: i + 1, content: lines[i] ?? "" });
      }
    }

    this.log.debug("Search output completed", {
      sessionId,
      pattern,
      matches: results.length,
    });

    return results;
  }

  // -----------------------------------------------------------------------
  // Private helpers — storage
  // -----------------------------------------------------------------------

  /**
   * Load all session records from persistent storage.
   */
  private async loadSessions(): Promise<SessionInfo[]> {
    if (!this.sessionsStore) return [];
    const data = await this.sessionsStore.get();
    return data ?? [];
  }

  /**
   * Save the full session list to persistent storage.
   */
  private async saveSessions(sessions: SessionInfo[]): Promise<void> {
    if (!this.sessionsStore) return;
    try {
      await this.sessionsStore.set(sessions);
    } catch (err) {
      this.log.error("Failed to save sessions to storage", {
        error: String(err),
      });
    }
  }

  /**
   * Save (upsert) a single session record.
   */
  private async saveSession(session: SessionInfo): Promise<void> {
    const sessions = await this.loadSessions();
    const idx = sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
      sessions[idx] = session;
    } else {
      sessions.push(session);
    }
    await this.saveSessions(sessions);
  }

  // -----------------------------------------------------------------------
  // Private helpers — zellij utilities
  // -----------------------------------------------------------------------

  /**
   * Extract the zellij session name from a SessionInfo record.
   */
  private getZellijSessionName(session: SessionInfo): string {
    const meta = session.metadata as Record<string, unknown> | undefined;
    if (meta && typeof meta.zellijSessionName === "string") {
      return meta.zellijSessionName;
    }
    return `vibe-${session.id}`;
  }

  /**
   * Look up a session by ID and throw if not found.
   */
  private async requireSession(sessionId: string): Promise<SessionInfo> {
    const session = await this.getInfo(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.status === "terminated") {
      throw new Error(`Session is terminated: ${sessionId}`);
    }
    return session;
  }

  /**
   * Get TerminalInfo for a session if ttyd is currently running.
   */
  private getRunningTerminalInfo(sessionId: string): TerminalInfo | null {
    const pid = this.ttydPids.get(sessionId);
    const port = this.ttydPorts.get(sessionId);

    if (!pid || port === undefined) {
      return null;
    }

    // Verify process is still alive
    if (!isProcessAlive(pid)) {
      this.ttydPids.delete(sessionId);
      this.ttydPorts.delete(sessionId);
      return null;
    }

    return {
      url: `http://localhost:${port}`,
      port,
      pid,
      host: TERMINAL_HOST,
      wsPath: TERMINAL_WS_PATH,
      subprotocols: TERMINAL_SUBPROTOCOLS,
    };
  }

  /**
   * Install the zellij multiplexer into the agent's binary cache via the SDK
   * installer. Exposed publicly so the plugin's prereqs routes can drive the
   * install on demand (the agent never installs tools itself — it only
   * triggers this plugin via the prereqs protocol). Throws on failure so the
   * caller can surface a manual fallback.
   */
  async installZellij(): Promise<void> {
    await ensureZellijBinary(this.log);
  }

  /**
   * Install the ttyd terminal-server into the agent's binary cache via the SDK
   * installer. Exposed publicly so the plugin's prereqs routes can drive the
   * install on demand. Throws on failure so the caller can surface a manual
   * fallback.
   */
  async installTtyd(): Promise<void> {
    await ensureTtydBinary(this.log);
  }

  /**
   * Ensure zellij + ttyd are installed, auto-installing any that are missing.
   * Resolves each via the provider-managed cache or PATH first; only downloads
   * what is absent. Failures are logged (degrade gracefully) — the prereqs
   * routes provide the explicit install/repair path.
   */
  private async ensureDependencies(): Promise<void> {
    if (resolveBinary("zellij") === null) {
      this.log.info("zellij not found — attempting auto-install");
      try {
        await this.installZellij();
        this.log.info("zellij auto-installed successfully");
      } catch (err) {
        this.log.error("zellij auto-install failed", { error: String(err) });
      }
    } else {
      this.log.debug("zellij already available");
    }

    if (resolveBinary("ttyd") === null) {
      this.log.info("ttyd not found — attempting auto-install");
      try {
        await this.installTtyd();
        this.log.info("ttyd auto-installed successfully");
      } catch (err) {
        this.log.error("ttyd auto-install failed", { error: String(err) });
      }
    } else {
      this.log.debug("ttyd already available");
    }
  }

  private async persistTerminals(): Promise<void> {
    if (!this.terminalsStore) return;
    const data: Record<string, PersistedTerminal> = {};
    for (const [sessionId, pid] of this.ttydPids) {
      const port = this.ttydPorts.get(sessionId);
      if (port !== undefined) {
        data[sessionId] = { pid, port };
      }
    }
    try {
      await this.terminalsStore.set(data);
    } catch {
      this.log.warn("Failed to persist terminal state");
    }
  }

  private async loadPersistedTerminals(): Promise<
    Record<string, PersistedTerminal>
  > {
    if (!this.terminalsStore) return {};
    const data = await this.terminalsStore.get();
    return data ?? {};
  }

  /**
   * Reconcile persisted session records against actual zellij state.
   * Recovers ttyd processes from persisted data and adopts orphans.
   */
  private async reconcileSessions(): Promise<void> {
    const sessions = await this.loadSessions();
    const persistedTerminals = await this.loadPersistedTerminals();
    let changed = false;

    for (const session of sessions) {
      if (session.status === "terminated") continue;

      const zellijSessionName = this.getZellijSessionName(session);
      const exists = zellijSessionExists(zellijSessionName);

      if (!exists) {
        // Zellij session is gone
        if (session.status === "active") {
          session.status = "inactive";
          session.updatedAt = nowISO();
          session.terminal = undefined;
          changed = true;
          this.log.info("Reconciled: zellij session gone, marking inactive", {
            id: session.id,
          });
        }
        // Kill orphaned ttyd for dead zellij session
        const termData = persistedTerminals[session.id];
        if (termData && isProcessAlive(termData.pid)) {
          this.log.info("Killing orphaned ttyd for dead zellij session", {
            sessionId: session.id,
            pid: termData.pid,
          });
          await gracefulKill(termData.pid);
        }
        delete persistedTerminals[session.id];
        continue;
      }

      // Zellij session exists — try to recover ttyd
      const termData = persistedTerminals[session.id];
      if (termData) {
        if (isProcessAlive(termData.pid)) {
          // ttyd is still alive — re-adopt it
          this.ttydPids.set(session.id, termData.pid);
          this.ttydPorts.set(session.id, termData.port);
          session.terminal = {
            url: `http://localhost:${termData.port}`,
            port: termData.port,
            pid: termData.pid,
            host: TERMINAL_HOST,
            wsPath: TERMINAL_WS_PATH,
            subprotocols: TERMINAL_SUBPROTOCOLS,
          };
          session.status = "active";
          session.updatedAt = nowISO();
          changed = true;
          this.log.info("Recovered ttyd process", {
            sessionId: session.id,
            pid: termData.pid,
            port: termData.port,
          });
        } else {
          // ttyd died — clear stale data
          session.terminal = undefined;
          changed = true;
          delete persistedTerminals[session.id];
          this.log.info("Stale ttyd record cleared (process dead)", {
            sessionId: session.id,
          });
        }
      }

      // Ensure active zellij sessions are marked active
      if (exists && session.status !== "active") {
        session.status = "active";
        session.updatedAt = nowISO();
        changed = true;
      }
    }

    // Phase 2: Scan for orphaned ttyd processes not in persisted data
    try {
      const pgrepResult = Bun.spawnSync(["pgrep", "-a", "ttyd"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });
      const raw = pgrepResult.stdout.toString().trim();
      if (raw) {
        for (const line of raw.split("\n")) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[0] ?? "0", 10);
          if (!pid) continue;

          // Skip already-recovered processes
          if ([...this.ttydPids.values()].includes(pid)) continue;

          // Look for "zellij attach <session-name>" in the command line
          const attachIdx = parts.indexOf("attach");
          const zellijTarget = attachIdx !== -1 ? parts[attachIdx + 1] : null;
          if (!zellijTarget) continue;

          // Match to a known session
          const matchedSession = sessions.find(
            (s) =>
              s.status !== "terminated" &&
              this.getZellijSessionName(s) === zellijTarget,
          );
          if (!matchedSession) continue;

          // Extract port from --port <N>
          const portIdx = parts.indexOf("--port");
          const port =
            portIdx !== -1 ? parseInt(parts[portIdx + 1] ?? "0", 10) : 0;
          if (!port) continue;

          // Adopt the orphan
          this.ttydPids.set(matchedSession.id, pid);
          this.ttydPorts.set(matchedSession.id, port);
          matchedSession.terminal = {
            url: `http://localhost:${port}`,
            port,
            pid,
            host: TERMINAL_HOST,
            wsPath: TERMINAL_WS_PATH,
            subprotocols: TERMINAL_SUBPROTOCOLS,
          };
          matchedSession.status = "active";
          matchedSession.updatedAt = nowISO();
          changed = true;
          this.log.info("Adopted orphaned ttyd process", {
            sessionId: matchedSession.id,
            pid,
            port,
            zellijTarget,
          });
        }
      }
    } catch {
      // pgrep not found or no ttyd processes — that's fine
    }

    if (changed) {
      await this.saveSessions(sessions);
    }
    await this.persistTerminals();
  }
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

/**
 * Module-level provider singleton — zellij sessions are global OS
 * resources keyed by name and we must not spawn duplicate sessions per
 * profile. The factory binds to this provider on first call and reuses
 * it across createPlugin invocations.
 */
const provider = new ZellijSessionProvider();

/**
 * Prereqs routes — this plugin OWNS installing the `zellij` binary via the
 * agent's standard plugin prereqs protocol. The agent never installs tools
 * itself; it only calls these endpoints. Install logic lives in the provider
 * (delegated to via `provider.installZellij()`).
 *
 * `Bun.which` snapshots PATH at process start, so we always pass an explicit
 * `{ PATH: process.env.PATH }` to honour any PATH mutations made by an install.
 */
interface PendingSudo {
  name: string;
  command: string;
  reason: string;
}

/** Check if we are running on macOS (used for manual-install fallbacks). */
function isMacOSPlatform(): boolean {
  return process.platform === "darwin";
}

/** Manual install instruction for a tool when the auto-download fails. */
function manualInstructionFor(tool: "zellij" | "ttyd"): string {
  if (tool === "zellij") {
    return isWindows()
      ? "irm https://zellij.dev/launch.ps1 | iex    # or download zellij-x86_64-pc-windows-msvc.zip from https://github.com/zellij-org/zellij/releases"
      : isMacOSPlatform()
        ? "brew install zellij    # or download from https://github.com/zellij-org/zellij/releases"
        : "see https://github.com/zellij-org/zellij/releases for prebuilt binaries";
  }
  // ttyd
  return isWindows()
    ? "scoop install ttyd    # or download ttyd.win32.exe from https://github.com/tsl0922/ttyd/releases"
    : isMacOSPlatform()
      ? "brew install ttyd    # ttyd ships no static macOS binary"
      : "see https://github.com/tsl0922/ttyd/releases for prebuilt binaries";
}

function createPrereqsRoutes() {
  return new Elysia({ prefix: "/prereqs" })
    .get("/status", () => {
      const zellijOk = resolveBinary("zellij") !== null;
      const ttydOk = resolveBinary("ttyd") !== null;
      const missing: Array<{
        name: string;
        kind: "binary";
        requiresSudo: boolean;
      }> = [];
      if (!zellijOk) {
        missing.push({ name: "zellij", kind: "binary", requiresSudo: false });
      }
      if (!ttydOk) {
        missing.push({ name: "ttyd", kind: "binary", requiresSudo: false });
      }
      return { satisfied: missing.length === 0, missing };
    })
    .post("/install", async () => {
      const installed: string[] = [];
      const pendingSudo: PendingSudo[] = [];
      const errors: Array<{ name: string; message: string }> = [];

      // zellij — download into the agent binary cache if absent.
      if (resolveBinary("zellij") === null) {
        try {
          await provider.installZellij();
          installed.push("zellij");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          pendingSudo.push({
            name: "zellij",
            command: manualInstructionFor("zellij"),
            reason: `zellij auto-download failed: ${message}`,
          });
          errors.push({ name: "zellij", message });
        }
      }

      // ttyd — download into the agent binary cache if absent.
      if (resolveBinary("ttyd") === null) {
        try {
          await provider.installTtyd();
          installed.push("ttyd");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          pendingSudo.push({
            name: "ttyd",
            command: manualInstructionFor("ttyd"),
            reason: `ttyd auto-download failed: ${message}`,
          });
          errors.push({ name: "ttyd", message });
        }
      }

      return {
        ok: errors.length === 0,
        installed,
        pendingSudo,
        errors,
      };
    })
    .post("/uninstall", () => ({ ok: true }));
}

/**
 * Plugin contract V2 factory. Builds a fresh VibePlugin (with its own
 * lifecycle/telemetry instances) per call. The `provider` module-level
 * binding is reused because zellij sessions are global OS resources.
 */
export const createPlugin: VibePluginFactory = (
  _ctx: ProfileContext,
): VibePlugin => {
  // Lifecycle hooks via SDK — auto-emits `<plugin>.ready` telemetry and
  // delegates to provider.
  const lifecycle = createLifecycleHooks({
    name: PLUGIN_NAME,
    telemetryEventName: `${PLUGIN_NAME}.ready`,
    onInit: async (services: HostServices) => {
      new ProviderRegistry(services).registerProvider(
        "session",
        PROVIDER_NAME,
        provider,
      );
      new TelemetryEmitter(PLUGIN_NAME, PLUGIN_VERSION, services).emit(
        "session.provider.ready",
        { provider: "zellij" },
      );
      await provider.init(services);
    },
    onShutdown: async () => {
      await provider.shutdown({ reason: "shutdown" });
    },
    // `vibe nuke` runs this while the daemon is still up, so the provider
    // singleton + its in-memory ttyd PID map are reachable. Force-reap every
    // ttyd terminal-server and zellij session this plugin spawned and wipe its
    // storage namespace. The agent never names ttyd or zellij — that knowledge
    // lives here.
    onNuke: async (_hostServices, ctx) => {
      if (ctx.dryRun) {
        return {
          reaped: [
            "ttyd terminal-server processes + zellij sessions + session-zellij storage",
          ],
        };
      }
      const reaped = await provider.nuke();
      return { reaped };
    },
  });

  const plugin: VibePlugin = {
    capabilities: {
      storage: "rw",
      subprocess: true,
      telemetry: true,
    },
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description:
      "Zellij + ttyd session provider — manages terminal sessions via Zellij and exposes web terminals via ttyd",
    tags: ["backend", "provider"],
    apiPrefix: "/api/session-zellij",

    prerequisites: [
      {
        name: "zellij",
        kind: "binary",
        requiresSudo: false,
      },
      {
        name: "ttyd",
        kind: "binary",
        requiresSudo: false,
      },
    ],

    createRoutes: () => createPrereqsRoutes(),
    onServerStart: lifecycle.onServerStart,
    onServerStop: lifecycle.onServerStop,
    onNuke: lifecycle.onNuke,
  };

  return plugin;
};

export type {
  SessionProvider,
  SessionProviderCapabilities,
  SessionConfig,
  SessionInfo,
  SessionStatus,
  TerminalInfo,
  HealthCheckResult,
  SystemSessionInfo,
  SystemTerminalInfo,
};
