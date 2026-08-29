'use strict';

/**
 * Playground WebSocket Handler
 *
 * Manages browser-based voice conversations without telephony.
 * The browser captures mic audio and sends it over WebSocket;
 * this handler runs the STT → LLM → TTS loop and sends results back.
 *
 * Message protocol (browser → server):
 *   JSON text frames:
 *     { type: "start", language: "hi"|"en", variables: {...} }
 *     { type: "stop" }
 *     { type: "barge-in" }           — User interrupted during agent speech
 *     { type: "speech-detected" }    — VAD detected speech (resets silence timer)
 *     { type: "silence-detected" }   — VAD detected silence after speech (endpoint check)
 *   Binary frames:
 *     Raw Int16 PCM audio (16kHz mono) — only during speech (VAD-gated)
 *
 * Message protocol (server → browser):
 *   { type: "status", state: "idle"|"listening"|"thinking"|"speaking" }
 *   { type: "transcript", text, isFinal }
 *   { type: "agent_response", text }
 *   { type: "audio", data: "<base64 PCM>" }
 *   { type: "outcome", label, reason }
 *   { type: "error", message }
 *
 * The playground bypasses Vapi entirely — it talks directly to Sarvam
 * through the existing adapter layer.
 */

const logger = require('../utils/logger');

/**
 * Handle a single playground WebSocket connection.
 *
 * @param {WebSocket} ws - The WebSocket connection from the browser
 * @param {Object} deps - Dependencies
 * @param {Object} deps.providerRegistry - ProviderRegistry instance
 * @param {Object} deps.strategy - Active ConversationStrategy
 */
function handlePlaygroundConnection(ws, deps) {
  const { providerRegistry, strategy } = deps;

  let conversation = null;

  /**
   * Send a JSON message to the browser.
   * @param {Object} message
   */
  function send(message) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify(message));
    }
  }

  ws.on('message', async (data, isBinary) => {
    try {
      if (isBinary) {
        // Binary frame = raw audio chunk from browser (VAD-gated, only during speech)
        if (conversation) {
          await conversation.processAudio(data);
        }
      } else {
        // Text frame = JSON control message
        const message = JSON.parse(data.toString());

        switch (message.type) {
          case 'start': {
            // Start a new conversation
            const { PlaygroundConversation } = require('./conversation');
            conversation = new PlaygroundConversation({
              providerRegistry,
              strategy,
              language: message.language || 'hi',
              variables: message.variables || {},
              onTranscript: (text, isFinal) => {
                send({ type: 'transcript', text, isFinal });
              },
              onAgentResponse: (text) => {
                send({ type: 'agent_response', text });
              },
              onAudio: (audioBuffer) => {
                send({
                  type: 'audio',
                  data: audioBuffer.toString('base64'),
                });
              },
              onOutcome: (outcome) => {
                send({ type: 'outcome', label: outcome.label, reason: outcome.reason });
              },
              onStateChange: (oldState, newState) => {
                send({ type: 'status', state: newState });
              },
              onError: (err) => {
                send({ type: 'error', message: err.message });
                logger.error('playground_error', err);
              },
            });

            await conversation.start();
            break;
          }

          case 'stop':
            if (conversation) {
              await conversation.stop();
              conversation = null;
            }
            send({ type: 'status', state: 'idle' });
            break;

          case 'barge-in':
            // User interrupted during agent speech
            if (conversation) {
              conversation.bargeIn();
            }
            break;

          case 'speech-detected':
            // VAD detected speech — resets silence timer
            if (conversation) {
              conversation.speechDetected();
            }
            break;

          case 'silence-detected':
            // VAD detected silence after speech — triggers endpoint check
            if (conversation) {
              conversation.silenceDetected();
            }
            break;

          default:
            send({ type: 'error', message: `Unknown message type: ${message.type}` });
        }
      }
    } catch (err) {
      logger.error('playground_message_error', err);
      send({ type: 'error', message: err.message });
    }
  });

  ws.on('close', async () => {
    logger.log('playground_disconnect');
    if (conversation) {
      try { await conversation.stop(); } catch (e) { /* ignore */ }
      conversation = null;
    }
  });

  ws.on('error', (err) => {
    logger.error('playground_ws_error', err);
  });

  // Send initial status
  send({ type: 'status', state: 'idle' });
  logger.log('playground_connect');
}

module.exports = { handlePlaygroundConnection };
