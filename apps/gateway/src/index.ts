import { optionalEnv, sarvamApiKey } from "@svara/shared";

/**
 * Voice gateway — long-lived WebSocket per session, VAD, barge-in, session
 * state, and one Temporal turn workflow per utterance. Phase 1 builds the
 * server; see docs/ROADMAP.md and docs/ARCHITECTURE.md.
 *
 * This must stay a standalone stateful Node service. An edge/serverless runtime
 * will drop the socket.
 *
 * Today it does the Phase 0 job: fail fast if the environment is wrong, and
 * prove the key is loadable without being loggable.
 */
const config = {
  port: Number(optionalEnv("GATEWAY_PORT", "8787")),
  wsPath: optionalEnv("GATEWAY_WS_PATH", "/voice"),
  temporalAddress: optionalEnv("TEMPORAL_ADDRESS", "localhost:7233"),
  // Throws at boot if SARVAM_API_KEY is missing. Safe to log: Secret redacts itself.
  sarvamApiKey: sarvamApiKey(),
};

console.log("svara gateway — config loaded:", config);
console.log(`WebSocket server arrives in Phase 1 (ws://localhost:${config.port}${config.wsPath}).`);
