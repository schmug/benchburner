/**
 * Remote File API WebSocket server — the harness side of Bitburner's
 * RFA. Bitburner connects to us (it's the client in the protocol);
 * we initiate requests, the game processes them and responds.
 *
 * Protocol: JSON-RPC-ish messages per bitburner/src/src/RemoteFileAPI/
 * MessageDefinitions.ts. Each request carries an `id`; the response
 * echoes it.
 *
 * Methods we use (a subset of what Bitburner exposes):
 *   - pushFile({ filename, content, server })  → "OK"
 *   - getFile({ filename, server })            → content:string
 *   - deleteFile({ filename, server })         → "OK"
 *   - getSaveFile()                             → { identifier, binary, save }
 */

import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket as WsClient } from "ws";

interface RFAMessage {
  jsonrpc?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: string;
  id?: number;
}

export interface RFAServerOptions {
  port: number;
  /** Called when a game instance connects. */
  onConnected?(): void;
  /** Called when the game disconnects (socket closed). */
  onDisconnected?(): void;
}

/**
 * Accepts one Bitburner connection at a time. If the game reconnects,
 * the new socket replaces the old one (old in-flight requests fail).
 */
export class RFAServer {
  private readonly wss: WebSocketServer;
  private socket?: WsClient;
  private readonly pending = new Map<number, { resolve(r: unknown): void; reject(e: Error): void }>();
  private nextId = 1;
  private connectedResolver?: () => void;
  private connectedPromise: Promise<void>;

  constructor(private readonly opts: RFAServerOptions) {
    this.wss = new WebSocketServer({ port: opts.port, host: "127.0.0.1" });
    this.connectedPromise = new Promise((r) => (this.connectedResolver = r));

    this.wss.on("connection", (ws) => {
      if (this.socket) {
        try {
          this.socket.close();
        } catch {
          /* ignore */
        }
      }
      this.socket = ws;
      this.connectedResolver?.();
      this.opts.onConnected?.();

      ws.on("message", (raw) => {
        let msg: RFAMessage;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg.result);
        }
        // unsolicited messages: ignored for M1
      });

      ws.on("close", () => {
        if (this.socket === ws) {
          this.socket = undefined;
          // Fail all in-flight requests
          for (const p of this.pending.values()) p.reject(new Error("RFA socket closed"));
          this.pending.clear();
          // Reset the connected promise so next connect can await again.
          this.connectedPromise = new Promise((r) => (this.connectedResolver = r));
          this.opts.onDisconnected?.();
        }
      });
    });
  }

  /** Resolves once a Bitburner instance connects. */
  waitForConnect(timeoutMs: number): Promise<void> {
    return Promise.race([
      this.connectedPromise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(`RFA connect timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  }

  isConnected(): boolean {
    return !!this.socket && this.socket.readyState === 1;
  }

  /** Close the server and drop all pending requests. */
  async close(): Promise<void> {
    for (const p of this.pending.values()) p.reject(new Error("RFA server closing"));
    this.pending.clear();
    if (this.socket) this.socket.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private async request(method: string, params?: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (!this.socket) throw new Error("RFA not connected");
    const id = this.nextId++;
    const payload: RFAMessage = { jsonrpc: "2.0", method, params, id };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RFA ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      // Clear timeout on resolution.
      const orig = this.pending.get(id)!;
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timeout);
          orig.resolve(r);
        },
        reject: (e) => {
          clearTimeout(timeout);
          orig.reject(e);
        },
      });
      this.socket!.send(JSON.stringify(payload));
    });
  }

  // ── Convenience wrappers ───────────────────────────────────────

  async pushFile(filename: string, content: string, server = "home"): Promise<void> {
    await this.request("pushFile", { filename, content, server });
  }

  async getFile(filename: string, server = "home"): Promise<string> {
    const r = (await this.request("getFile", { filename, server })) as string;
    return typeof r === "string" ? r : "";
  }

  async deleteFile(filename: string, server = "home"): Promise<void> {
    try {
      await this.request("deleteFile", { filename, server });
    } catch {
      // Best-effort
    }
  }

  async getFileNames(server = "home"): Promise<string[]> {
    const r = (await this.request("getFileNames", { server })) as unknown;
    return Array.isArray(r) ? (r as string[]) : [];
  }

  async getAllServers(): Promise<Array<{ hostname: string; hasAdminRights: boolean; purchasedByPlayer: boolean }>> {
    const r = (await this.request("getAllServers")) as unknown;
    return Array.isArray(r) ? (r as Array<{ hostname: string; hasAdminRights: boolean; purchasedByPlayer: boolean }>) : [];
  }

  async getSaveFile(): Promise<{ identifier: string; binary: boolean; save: string } | null> {
    const r = (await this.request("getSaveFile", undefined, 60_000)) as unknown;
    if (r && typeof r === "object" && "save" in r) {
      return r as { identifier: string; binary: boolean; save: string };
    }
    return null;
  }

  /** File existence check via metadata; returns null if not found. */
  async getFileMetadata(filename: string, server = "home"): Promise<{ mtime: number } | null> {
    try {
      const r = (await this.request("getFileMetadata", { filename, server })) as { mtime?: number } | null;
      return r && typeof r.mtime === "number" ? { mtime: r.mtime } : null;
    } catch {
      return null;
    }
  }

  /** Debug helper. */
  pendingCount(): number {
    return this.pending.size;
  }

  /** A disposable request id; useful for consumers that want to tag pushed files. */
  freshId(): string {
    return randomUUID();
  }
}
