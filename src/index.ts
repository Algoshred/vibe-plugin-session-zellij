/**
 * @burdenoff/vibe-plugin-session-zellij
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
}

// ---------------------------------------------------------------------------
// HostServices — provided by the vibe-agent runtime at plugin load
// ---------------------------------------------------------------------------

interface HostLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

interface HostStorage {
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<void>;
  delete(namespace: string, key: string): Promise<boolean>;
}

interface HostServices {
  logger: HostLogger;
  storage: HostStorage;
}

// ---------------------------------------------------------------------------
// VibePlugin interface
// ---------------------------------------------------------------------------

interface VibePlugin {
  name: string;
  version: string;
  description: string;
  tags?: Array<
    "backend" | "frontend" | "cli" | "provider" | "adapter" | "integration"
  >;
  providers: {
    session?: SessionProvider;
  };
  onServerStart?(services: HostServices): Promise<void>;
  onServerStop?(context?: { reason: "reload" | "shutdown" }): Promise<void>;
  onCliSetup?(): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_NAME = "session-zellij";
const STORAGE_NAMESPACE = "session-zellij";
const STORAGE_KEY_SESSIONS = "sessions";
const TTYD_BASE_PORT = 8081;
const TTYD_PORT_RANGE = 200;
const GRACEFUL_KILL_TIMEOUT_MS = 3000;

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

/**
 * Check if we are running on macOS.
 */
function isMacOS(): boolean {
  return process.platform === "darwin";
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
  const result = Bun.spawnSync(["zellij", ...args], {
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
    const result = Bun.spawnSync(["zellij", ...args], {
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
 * Find an available TCP port starting from `start` within the configured range.
 */
async function findAvailablePort(start: number): Promise<number> {
  for (let port = start; port < start + TTYD_PORT_RANGE; port++) {
    const available = await isPortAvailable(port);
    if (available) {
      return port;
    }
  }
  throw new Error(
    `No available port found in range ${start}-${start + TTYD_PORT_RANGE - 1}`,
  );
}

/**
 * Check whether a TCP port is available by attempting to bind to it.
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const server = Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: {
          data() {},
        },
      });
      server.stop(true);
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Send SIGTERM to a process, then SIGKILL after timeout if still alive.
 * On Windows, uses taskkill.
 */
async function gracefulKill(
  pid: number,
  timeout: number = GRACEFUL_KILL_TIMEOUT_MS,
): Promise<void> {
  if (isWindows()) {
    // On Windows, use taskkill
    try {
      Bun.spawnSync(["taskkill", "/PID", String(pid), "/F"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });
    } catch {
      // Process already dead
    }
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process already dead — nothing to do
    return;
  }

  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    await sleep(200);
    if (!isProcessAlive(pid)) {
      return;
    }
  }

  // Force kill
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone
  }
}

/**
 * Check if a process is still alive.
 * On Windows, uses tasklist to check.
 */
function isProcessAlive(pid: number): boolean {
  if (isWindows()) {
    try {
      const result = Bun.spawnSync(
        ["tasklist", "/FI", `PID eq ${pid}`, "/NH"],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        },
      );
      const output = result.stdout.toString();
      return output.includes(String(pid));
    } catch {
      return false;
    }
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Simple async sleep.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

class ZellijSessionProvider implements SessionProvider {
  readonly name = PROVIDER_NAME;

  private services: HostServices | null = null;

  /** Logger with safe no-op fallback until init() is called. */
  private log: HostLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  /** Storage with safe in-memory fallback until init() is called. */
  private storage: HostStorage = (() => {
    const mem = new Map<string, string>();
    return {
      get: async (namespace: string, key: string) =>
        mem.get(`${namespace}:${key}`) ?? null,
      set: async (namespace: string, key: string, value: string) => {
        mem.set(`${namespace}:${key}`, value);
      },
      delete: async (namespace: string, key: string) => {
        return mem.delete(`${namespace}:${key}`);
      },
    };
  })();

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
    this.services = services;
    if (services.logger) this.log = services.logger;
    if (services.storage) this.storage = services.storage;

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
      await this.storage.delete(STORAGE_NAMESPACE, "terminals");
    } catch {
      /* ignore */
    }
    this.log.info("ZellijSessionProvider shutdown complete");
  }

  // -----------------------------------------------------------------------
  // SessionProvider — create / terminate / getInfo / list
  // -----------------------------------------------------------------------

  async create(config: SessionConfig): Promise<SessionInfo> {
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
      if (isWindows()) {
        // On Windows, spawn zellij directly (no script command)
        Bun.spawn(["zellij", "-s", zellijSessionName], {
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
            `script -qfc "zellij -s ${zellijSessionName}" /dev/null </dev/null >/dev/null 2>&1`,
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
    const tmpFile = `/tmp/vibe-zellij-capture-${sessionId}-${Date.now()}.txt`;

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

    // Find available port
    const assignedPort = port ?? (await findAvailablePort(TTYD_BASE_PORT));

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

    const child = Bun.spawn(
      [
        "ttyd",
        "-t",
        "fontSize=14",
        "-t",
        `theme={"background":"#1e1e1e","foreground":"#cccccc"}`,
        "--writable",
        "--port",
        String(assignedPort),
        "zellij",
        "attach",
        zellijSessionName,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
        env: ttydEnv as Record<string, string>,
      },
    );

    if (!child.pid) {
      throw new Error("Failed to start ttyd — no PID returned");
    }

    // Give ttyd a moment to bind the port
    await sleep(500);

    // Store references
    this.ttydPids.set(sessionId, child.pid);
    this.ttydPorts.set(sessionId, assignedPort);
    await this.persistTerminals();

    const terminalInfo: TerminalInfo = {
      url: `http://localhost:${assignedPort}`,
      port: assignedPort,
      pid: child.pid,
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

    // Check ttyd availability
    let ttydOk = false;
    try {
      const whichCmd = isWindows() ? "where" : "which";
      const whichResult = Bun.spawnSync([whichCmd, "ttyd"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });
      ttydOk = whichResult.exitCode === 0;
    } catch {
      // ttyd not found
    }

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
  // Private helpers — storage
  // -----------------------------------------------------------------------

  /**
   * Load all session records from persistent storage.
   */
  private async loadSessions(): Promise<SessionInfo[]> {
    try {
      const raw = await this.storage.get(
        STORAGE_NAMESPACE,
        STORAGE_KEY_SESSIONS,
      );
      if (!raw) return [];
      return JSON.parse(raw) as SessionInfo[];
    } catch (err) {
      this.log.error("Failed to load sessions from storage", {
        error: String(err),
      });
      return [];
    }
  }

  /**
   * Save the full session list to persistent storage.
   */
  private async saveSessions(sessions: SessionInfo[]): Promise<void> {
    try {
      await this.storage.set(
        STORAGE_NAMESPACE,
        STORAGE_KEY_SESSIONS,
        JSON.stringify(sessions),
      );
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
    };
  }

  /**
   * Ensure zellij is installed, auto-installing if missing.
   * Checks if `zellij` is in PATH and installs it if not found.
   */
  private async ensureDependencies(): Promise<void> {
    // Check if zellij is already available
    try {
      const result = Bun.spawnSync(["zellij", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      if (result.exitCode === 0) {
        this.log.debug("zellij is already installed", {
          version: result.stdout.toString("utf-8").trim(),
        });
        return;
      }
    } catch {
      // Not found — proceed to install
    }

    this.log.info("zellij not found in PATH — attempting auto-install");

    if (isWindows()) {
      await this.installZellijWindows();
    } else if (isMacOS()) {
      await this.installZellijMacOS();
    } else {
      await this.installZellijLinux();
    }

    // Verify installation
    try {
      const result = Bun.spawnSync(["zellij", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      if (result.exitCode === 0) {
        this.log.info("zellij auto-installed successfully", {
          version: result.stdout.toString("utf-8").trim(),
        });
      } else {
        this.log.error("zellij auto-install completed but verification failed");
      }
    } catch {
      this.log.error("zellij auto-install completed but binary is not in PATH");
    }
  }

  /**
   * Install zellij on Linux by downloading the prebuilt binary.
   */
  private async installZellijLinux(): Promise<void> {
    const url =
      "https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz";
    const homeDir = process.env.HOME || "/root";
    const binDir = `${homeDir}/bin`;
    const tarPath = `/tmp/zellij-install-${Date.now()}.tar.gz`;

    try {
      // Ensure ~/bin exists
      Bun.spawnSync(["mkdir", "-p", binDir], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });

      this.log.info("Downloading zellij for Linux", { url, binDir });

      // Download the tarball
      const downloadResult = Bun.spawnSync(
        ["curl", "-fsSL", "-o", tarPath, url],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 120_000,
        },
      );

      if (downloadResult.exitCode !== 0) {
        const stderr = downloadResult.stderr.toString().trim();
        throw new Error(`Failed to download zellij: ${stderr}`);
      }

      // Extract to ~/bin
      const extractResult = Bun.spawnSync(
        ["tar", "-xzf", tarPath, "-C", binDir],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        },
      );

      if (extractResult.exitCode !== 0) {
        const stderr = extractResult.stderr.toString().trim();
        throw new Error(`Failed to extract zellij: ${stderr}`);
      }

      // Make executable
      Bun.spawnSync(["chmod", "+x", `${binDir}/zellij`], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });

      // Ensure ~/bin is in PATH for this process
      if (!process.env.PATH?.includes(binDir)) {
        process.env.PATH = `${binDir}:${process.env.PATH}`;
      }

      this.log.info("zellij installed to ~/bin/zellij");
    } catch (err) {
      this.log.error("Failed to install zellij on Linux", {
        error: String(err),
      });
    } finally {
      // Clean up tarball
      try {
        Bun.spawnSync(["rm", "-f", tarPath], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        });
      } catch {
        // Best-effort cleanup
      }
    }
  }

  /**
   * Install zellij on macOS. Tries Homebrew first, falls back to direct download.
   */
  private async installZellijMacOS(): Promise<void> {
    // Try Homebrew first
    try {
      const brewResult = Bun.spawnSync(["brew", "install", "zellij"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 300_000, // brew can be slow
      });

      if (brewResult.exitCode === 0) {
        this.log.info("zellij installed via Homebrew");
        return;
      }

      this.log.warn("Homebrew install failed, falling back to direct download");
    } catch {
      this.log.warn("Homebrew not available, falling back to direct download");
    }

    // Fallback: direct download (Apple Silicon by default, fallback to x86_64)
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    const url = `https://github.com/zellij-org/zellij/releases/latest/download/zellij-${arch}-apple-darwin.tar.gz`;
    const homeDir = process.env.HOME || "/Users/Shared";
    const binDir = `${homeDir}/bin`;
    const tarPath = `/tmp/zellij-install-${Date.now()}.tar.gz`;

    try {
      Bun.spawnSync(["mkdir", "-p", binDir], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });

      this.log.info("Downloading zellij for macOS", { url, binDir });

      const downloadResult = Bun.spawnSync(
        ["curl", "-fsSL", "-o", tarPath, url],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 120_000,
        },
      );

      if (downloadResult.exitCode !== 0) {
        const stderr = downloadResult.stderr.toString().trim();
        throw new Error(`Failed to download zellij: ${stderr}`);
      }

      const extractResult = Bun.spawnSync(
        ["tar", "-xzf", tarPath, "-C", binDir],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        },
      );

      if (extractResult.exitCode !== 0) {
        const stderr = extractResult.stderr.toString().trim();
        throw new Error(`Failed to extract zellij: ${stderr}`);
      }

      Bun.spawnSync(["chmod", "+x", `${binDir}/zellij`], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });

      if (!process.env.PATH?.includes(binDir)) {
        process.env.PATH = `${binDir}:${process.env.PATH}`;
      }

      this.log.info("zellij installed to ~/bin/zellij");
    } catch (err) {
      this.log.error("Failed to install zellij on macOS", {
        error: String(err),
      });
    } finally {
      try {
        Bun.spawnSync(["rm", "-f", tarPath], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        });
      } catch {
        // Best-effort cleanup
      }
    }
  }

  /**
   * Install zellij on Windows by downloading the prebuilt binary.
   */
  private async installZellijWindows(): Promise<void> {
    const url =
      "https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-pc-windows-msvc.zip";
    const localAppData =
      process.env.LOCALAPPDATA || `${process.env.USERPROFILE}\\AppData\\Local`;
    const installDir = `${localAppData}\\Programs\\Zellij`;
    const zipPath = `${process.env.TEMP || "C:\\Temp"}\\zellij-install-${Date.now()}.zip`;

    try {
      // Create install directory
      Bun.spawnSync(["cmd", "/c", `mkdir "${installDir}" 2>nul`], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });

      this.log.info("Downloading zellij for Windows", { url, installDir });

      // Download using PowerShell
      const downloadResult = Bun.spawnSync(
        [
          "powershell",
          "-Command",
          `Invoke-WebRequest -Uri "${url}" -OutFile "${zipPath}" -UseBasicParsing`,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 120_000,
        },
      );

      if (downloadResult.exitCode !== 0) {
        const stderr = downloadResult.stderr.toString().trim();
        throw new Error(`Failed to download zellij: ${stderr}`);
      }

      // Extract using PowerShell
      const extractResult = Bun.spawnSync(
        [
          "powershell",
          "-Command",
          `Expand-Archive -Path "${zipPath}" -DestinationPath "${installDir}" -Force`,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        },
      );

      if (extractResult.exitCode !== 0) {
        const stderr = extractResult.stderr.toString().trim();
        throw new Error(`Failed to extract zellij: ${stderr}`);
      }

      // Add to PATH for this process
      if (!process.env.PATH?.includes(installDir)) {
        process.env.PATH = `${installDir};${process.env.PATH}`;
      }

      this.log.info(`zellij installed to ${installDir}`);
    } catch (err) {
      this.log.error("Failed to install zellij on Windows", {
        error: String(err),
      });
    } finally {
      // Clean up zip
      try {
        Bun.spawnSync(["cmd", "/c", `del /q "${zipPath}" 2>nul`], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        });
      } catch {
        // Best-effort cleanup
      }
    }
  }

  private async persistTerminals(): Promise<void> {
    const data: Record<string, { pid: number; port: number }> = {};
    for (const [sessionId, pid] of this.ttydPids) {
      const port = this.ttydPorts.get(sessionId);
      if (port !== undefined) {
        data[sessionId] = { pid, port };
      }
    }
    try {
      await this.storage.set(
        STORAGE_NAMESPACE,
        "terminals",
        JSON.stringify(data),
      );
    } catch {
      this.log.warn("Failed to persist terminal state");
    }
  }

  private async loadPersistedTerminals(): Promise<
    Record<string, { pid: number; port: number }>
  > {
    try {
      const raw = await this.storage.get(STORAGE_NAMESPACE, "terminals");
      if (!raw) return {};
      return JSON.parse(raw);
    } catch {
      return {};
    }
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

const provider = new ZellijSessionProvider();

const vibePlugin: VibePlugin = {
  name: "@burdenoff/vibe-plugin-session-zellij",
  version: "2.3.0",
  description:
    "Zellij + ttyd session provider — manages terminal sessions via Zellij and exposes web terminals via ttyd",
  tags: ["backend", "provider"],

  providers: {
    session: provider,
  },

  async onServerStart(services: HostServices): Promise<void> {
    await provider.init(services);
  },

  async onServerStop(context?: {
    reason: "reload" | "shutdown";
  }): Promise<void> {
    await provider.shutdown(context);
  },
};

export { vibePlugin };
export type {
  SessionProvider,
  SessionConfig,
  SessionInfo,
  SessionStatus,
  TerminalInfo,
  HealthCheckResult,
  SystemSessionInfo,
  SystemTerminalInfo,
  VibePlugin,
  HostServices,
};
