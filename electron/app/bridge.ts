/**
 * Loopback HTTP bridge — exposes /health and /label-speakers for the Obsidian plugin.
 *
 * Security constraints (all required):
 * - Binds explicitly to 127.0.0.1 (never 0.0.0.0). Pitfall 6.
 * - Ephemeral port (port: 0) — avoids EADDRINUSE races between launches.
 * - 32-byte random hex bearer token, compared via crypto.timingSafeEqual.
 * - bridge.json written with mode 0o600 (user-readable only).
 * - /label-speakers: path traversal rejection via resolved-path prefix check.
 * - Graceful shutdown with 5-second timeout, force-close if exceeded. Pitfall 6.
 */

import { app } from "electron";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileSync, chmodSync } from "node:fs";
import { resolve as pathResolve, sep } from "node:path";
import type { ServerType } from "@hono/node-server";
import { log } from "../../src/log/core.js";
import { labelSpeakers } from "./service.js";
import { getPaths } from "./paths.js";

// ── Module-level state ────────────────────────────────────────────────────────

let _server: ServerType | null = null;
let _token: string | null = null;

// ── Token helpers ─────────────────────────────────────────────────────────────

/** Generate a 32-byte random hex token. */
function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Constant-time bearer token comparison.
 * MUST use timingSafeEqual (per spec) — regular === leaks timing.
 * Short-circuits to false (401) if lengths differ, without calling timingSafeEqual
 * (which requires equal-length buffers).
 */
function tokenIsValid(authHeader: string | undefined, expectedToken: string): boolean {
  if (!authHeader) return false;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  const incoming = authHeader.slice(prefix.length);
  // Length check first — timingSafeEqual requires equal-length buffers
  if (incoming.length !== expectedToken.length) return false;
  const a = Buffer.from(incoming, "utf8");
  const b = Buffer.from(expectedToken, "utf8");
  return timingSafeEqual(a, b);
}

// ── Bridge factory ────────────────────────────────────────────────────────────

export interface BridgeOptions {
  /** Absolute path to userData directory (bridge.json is written here). */
  userDataDir: string;
  /**
   * Returns the current vault path at request time.
   * Called on every /label-speakers request so config changes are reflected immediately.
   * Returns empty string if config is not yet loaded.
   */
  getVaultPath: () => string;
}

/**
 * Start the Hono bridge.
 * Binds to 127.0.0.1:0 (OS assigns ephemeral port), writes bridge.json, logs port.
 */
export async function startBridge(opts: BridgeOptions): Promise<void> {
  if (_server) {
    log("[bridge] already running, ignoring startBridge call");
    return;
  }

  const token = generateToken();
  _token = token;

  // ── Build Hono app ────────────────────────────────────────────────────────

  const honoApp = new Hono();

  // GET /health — no auth required
  honoApp.get("/health", (c) => {
    const authHeader = c.req.header("Authorization");
    return c.json({
      ok: true,
      version: app.getVersion(),
      authenticated: authHeader?.startsWith("Bearer ") ?? false,
    });
  });

  // POST /label-speakers — bearer auth required
  honoApp.post("/label-speakers", async (c) => {
    // Auth check
    const authHeader = c.req.header("Authorization");
    if (!tokenIsValid(authHeader, token)) {
      return c.json({ ok: false, error: "Unauthorized" }, 401);
    }

    // Parse body
    let body: { notePath?: unknown };
    try {
      body = await c.req.json() as { notePath?: unknown };
    } catch {
      return c.json({ ok: false, error: "Invalid JSON body" }, 400);
    }

    if (typeof body.notePath !== "string" || !body.notePath) {
      return c.json({ ok: false, error: "Missing or invalid notePath" }, 400);
    }

    const rawNotePath = body.notePath;

    // Path traversal rejection: resolve incoming path and check it starts with vaultPath
    const currentVaultPath = opts.getVaultPath();
    if (!currentVaultPath) {
      return c.json({ ok: false, error: "Vault not configured" }, 503);
    }
    const resolvedNote = pathResolve(rawNotePath);
    const resolvedVault = pathResolve(currentVaultPath);

    // Use path.sep boundary check to avoid partial-prefix matches
    // (e.g., /vault/foo must NOT match /vault/foobar as a prefix)
    const vaultPrefix = resolvedVault.endsWith(sep) ? resolvedVault : resolvedVault + sep;
    const isInsideVault =
      resolvedNote === resolvedVault ||
      resolvedNote.startsWith(vaultPrefix);

    if (!isInsideVault) {
      log(`[bridge] /label-speakers rejected path traversal: ${resolvedNote}`);
      return c.json({ ok: false, error: "notePath is outside vault" }, 400);
    }

    // Delegate to service
    try {
      const result = await labelSpeakers(resolvedNote);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("[bridge] /label-speakers error:", err);
      return c.json({ ok: false, error: msg }, 500);
    }
  });

  // 405 for wrong methods on known routes
  honoApp.all("/health", (c) => c.json({ ok: false, error: "Method not allowed" }, 405));
  honoApp.all("/label-speakers", (c) => c.json({ ok: false, error: "Method not allowed" }, 405));

  // ── Start server ──────────────────────────────────────────────────────────

  await new Promise<void>((resolve: (value: void) => void, reject) => {
    const server = serve(
      {
        fetch: honoApp.fetch,
        hostname: "127.0.0.1",
        port: 0, // OS assigns ephemeral port
      },
      (info) => {
        // Called when server is listening
        const port = info.port;
        _server = server;

        // Write bridge.json with mode 0o600
        const bridgeJsonPath = getPaths().bridgeJsonPath;
        const payload = JSON.stringify({
          port,
          token,
          version: app.getVersion(),
        });
        try {
          writeFileSync(bridgeJsonPath, payload, { mode: 0o600 });
          // Chmod after write for filesystems that don't honour mode on write
          chmodSync(bridgeJsonPath, 0o600);
        } catch (err) {
          log("[bridge] failed to write bridge.json:", err);
        }

        log(`[bridge] listening on 127.0.0.1:${port}`);
        resolve();
      },
    );

    // Handle bind errors
    server.on("error", (err: Error) => {
      log("[bridge] server error:", err);
      reject(err);
    });
  });
}

/**
 * Gracefully shut down the bridge.
 * Closes with a 5-second timeout; force-closes if exceeded (Node 18.2+ closeAllConnections).
 */
export async function stopBridge(): Promise<void> {
  const server = _server;
  if (!server) {
    return;
  }
  _server = null;
  _token = null;

  await new Promise<void>((resolveClose) => {
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      log("[bridge] forced shutdown (timeout exceeded)");
      // closeAllConnections is available in Node 18.2+
      if (typeof (server as ServerType & { closeAllConnections?: () => void }).closeAllConnections === "function") {
        (server as ServerType & { closeAllConnections: () => void }).closeAllConnections();
      }
      resolveClose();
    }, 5000);

    server.close(() => {
      if (!timedOut) {
        clearTimeout(timeout);
        log("[bridge] shutdown");
        resolveClose();
      }
    });
  });
}
