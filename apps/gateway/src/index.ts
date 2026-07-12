import { createServer } from "node:http";
import {
  configHashOf,
  connectTemporal,
  INTERNAL_WS_PATH,
  serverDefaultFlow,
  type GatewayFrame,
  type WorkerFrame,
} from "@svara/orchestrator";
import { optionalEnv, sarvamApiKey } from "@svara/shared";
import type { ClientMessage } from "@svara/shared";
import { WebSocketServer, type WebSocket } from "ws";
import { Session } from "./session.js";

/**
 * Voice gateway — the only stateful hop in the runtime plane.
 *
 * Two sockets:
 *  - /voice    the caller: PCM16 up, transcripts + synthesized audio down.
 *  - /internal the Temporal worker: caller audio down, hop output up.
 *
 * It must stay a standalone Node service. An edge/serverless runtime drops the
 * long-lived socket, and there is no voice loop without it.
 */
const port = Number(optionalEnv("GATEWAY_PORT", "8787"));
const wsPath = optionalEnv("GATEWAY_WS_PATH", "/voice");

// Fail at boot, not mid-call, if the key is missing. Secret redacts itself, so
// this can never end up in a log line (guardrail 2).
sarvamApiKey();

const temporal = await connectTemporal();

const sessions = new Map<string, Session>();
const workers = new Set<WebSocket>();

const server = createServer((req, res) => {
  /**
   * The flow this gateway will actually run a call with — the shipped defaults
   * with *this deployment's* env overlaid, plus the config hash its traces will
   * carry. The `/flow` canvas fetches it on mount and seeds itself from it.
   *
   * It has to come from here rather than being reconstructed in the browser or in
   * Next: only this process knows its own `LLM_MODEL` and `TTS_SPEAKER`. A canvas
   * that seeded from the client's copy of the defaults would silently show the
   * wrong speaker on any deployment that overrode one — and would show it right up
   * until the call was made.
   *
   * No secrets: model ids, an STT mode, a speaker name. The key never leaves
   * `Secret` (guardrail 2), and it is not in the flow.
   */
  if (req.method === "GET" && new URL(req.url ?? "/", "http://localhost").pathname === "/flow") {
    const flow = serverDefaultFlow();
    res.writeHead(200, {
      "content-type": "application/json",
      // The dashboard is a different origin (:3000) from the gateway (:8787).
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ flow, config_hash: configHashOf(flow) }));
    return;
  }

  res.writeHead(200, { "content-type": "text/plain" });
  res.end("svara gateway\n");
});

const callers = new WebSocketServer({ noServer: true });
const internal = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
  if (path === wsPath) {
    callers.handleUpgrade(req, socket, head, (ws) => callers.emit("connection", ws, req));
    return;
  }
  if (path === INTERNAL_WS_PATH) {
    internal.handleUpgrade(req, socket, head, (ws) => internal.emit("connection", ws, req));
    return;
  }
  socket.destroy();
});

/** Fan out to the worker(s). One worker in dev; a Set keeps a restart from racing. */
function toWorker(frame: GatewayFrame): void {
  const payload = JSON.stringify(frame);
  for (const worker of workers) {
    if (worker.readyState === worker.OPEN) worker.send(payload);
  }
}

callers.on("connection", (socket: WebSocket) => {
  const session = new Session(socket, temporal, toWorker);
  sessions.set(session.id, session);
  console.log(`[gateway] call ${session.id} connected`);

  socket.on("message", (data: Buffer, isBinary: boolean) => {
    // Binary is mic audio; JSON is control. Nothing else is on this socket.
    if (isBinary) {
      session.onAudio(data);
      return;
    }
    let message: ClientMessage;
    try {
      message = JSON.parse(data.toString("utf8")) as ClientMessage;
    } catch {
      return;
    }
    if (message.type === "start") session.onStart(message);
    else if (message.type === "configure") session.onConfigure(message.flow);
    else if (message.type === "stop") socket.close(1000, "caller hung up");
  });

  socket.on("close", () => {
    session.close();
    sessions.delete(session.id);
    console.log(`[gateway] call ${session.id} ended`);
  });
  socket.on("error", (err) => console.error(`[gateway] call ${session.id} error:`, err.message));
});

internal.on("connection", (socket: WebSocket) => {
  workers.add(socket);
  console.log("[gateway] worker attached");

  socket.on("message", (data: Buffer) => {
    let frame: WorkerFrame;
    try {
      frame = JSON.parse(data.toString("utf8")) as WorkerFrame;
    } catch (err) {
      console.error("[gateway] bad worker frame:", err);
      return;
    }
    sessions.get(frame.session_id)?.onWorkerFrame(frame);
  });

  socket.on("close", () => {
    workers.delete(socket);
    console.warn("[gateway] worker detached");
  });
  socket.on("error", (err) => console.error("[gateway] worker error:", err.message));
});

server.listen(port, () => {
  console.log(`svara gateway listening on ws://localhost:${port}${wsPath}`);
  console.log(`worker channel on ws://localhost:${port}${INTERNAL_WS_PATH}`);
});
