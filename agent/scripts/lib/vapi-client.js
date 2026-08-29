'use strict';

/**
 * Vapi API Client
 *
 * Shared client for all Vapi API operations. Used by:
 * - scripts/create-assistant.js
 * - scripts/update-assistant.js
 * - scripts/make-call.js
 * - scripts/run-simulation.js
 *
 * Centralizes: auth, base URL, error handling, response parsing.
 * Each script imports this instead of duplicating fetch logic.
 */

const VAPI_BASE_URL = 'https://api.vapi.ai';

/**
 * Get the Vapi API key from environment.
 * @returns {string} API key
 * @throws {Error} if VAPI_PRIVATE_KEY is not set
 */
function getApiKey() {
  const key = process.env.VAPI_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      'Missing env var: VAPI_PRIVATE_KEY\n' +
      'Set it in your .env file or export VAPI_PRIVATE_KEY=your_key'
    );
  }
  return key;
}

/**
 * Make an authenticated request to the Vapi API.
 * @param {string} method - HTTP method (GET, POST, PATCH, DELETE)
 * @param {string} path - API path (e.g., '/assistant', '/call')
 * @param {Object} [body] - Request body (for POST/PATCH)
 * @returns {Promise<Object>} Parsed JSON response
 * @throws {Error} with status code and response text on failure
 */
async function vapiRequest(method, path, body) {
  const apiKey = getApiKey();
  const url = `${VAPI_BASE_URL}${path}`;

  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Vapi API error (${response.status}) ${method} ${path}:\n${errorText}`);
  }

  // Some endpoints return 204 No Content
  if (response.status === 204) {
    return null;
  }

  return response.json();
}

// --- Assistant operations ---

/**
 * Create a new Vapi assistant.
 * @param {Object} config - Assistant configuration object
 * @returns {Promise<Object>} Created assistant (includes id)
 */
async function createAssistant(config) {
  return vapiRequest('POST', '/assistant', config);
}

/**
 * Update an existing Vapi assistant.
 * @param {string} assistantId - Vapi assistant ID
 * @param {Object} config - Updated assistant configuration
 * @returns {Promise<Object>} Updated assistant
 */
async function updateAssistant(assistantId, config) {
  return vapiRequest('PATCH', `/assistant/${assistantId}`, config);
}

/**
 * Get a Vapi assistant by ID.
 * @param {string} assistantId
 * @returns {Promise<Object>} Assistant config
 */
async function getAssistant(assistantId) {
  return vapiRequest('GET', `/assistant/${assistantId}`);
}

/**
 * List all Vapi assistants.
 * @returns {Promise<Array>} List of assistants
 */
async function listAssistants() {
  return vapiRequest('GET', '/assistant');
}

// --- Call operations ---

/**
 * Create an outbound call.
 * @param {string} assistantId - Vapi assistant ID
 * @param {string} phoneNumber - E.164 phone number (e.g., +91XXXXXXXXXX)
 * @param {Object} [variables] - Per-call variables (parent_name, drug_name, etc.)
 * @returns {Promise<Object>} Call object (includes id, status)
 */
async function createCall(assistantId, phoneNumber, variables = {}) {
  return vapiRequest('POST', '/call', {
    assistantId,
    customer: { number: phoneNumber },
    assistantOverrides: { variableValues: variables },
  });
}

/**
 * Get a call by ID.
 * @param {string} callId
 * @returns {Promise<Object>} Call object with transcript, analysis, status
 */
async function getCall(callId) {
  return vapiRequest('GET', `/call/${callId}`);
}

// --- Simulation operations ---

/**
 * Run a Vapi Simulation (AI-driven test call).
 * @param {Object} simulationConfig - Simulation configuration
 * @returns {Promise<Object>} Simulation result
 */
async function runSimulation(simulationConfig) {
  return vapiRequest('POST', '/simulation', simulationConfig);
}

module.exports = {
  getApiKey,
  vapiRequest,
  createAssistant,
  updateAssistant,
  getAssistant,
  listAssistants,
  createCall,
  getCall,
  runSimulation,
};
