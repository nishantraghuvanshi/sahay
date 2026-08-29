'use strict';

/**
 * Call Form — client-side logic
 *
 * Handles form submission, validation, call initiation via /api/call,
 * and optional status polling via /api/call/:callId.
 *
 * No external dependencies. No ES modules. Plain <script> tag.
 */
(function () {
  // --- DOM references ---
  var form = document.getElementById('callForm');
  var callBtn = document.getElementById('callBtn');
  var statusPill = document.getElementById('statusPill');
  var statusText = document.getElementById('statusText');
  var callIdDisplay = document.getElementById('callIdDisplay');
  var outcomeBox = document.getElementById('outcomeBox');
  var errorBox = document.getElementById('errorBox');

  // --- State ---
  var pollTimer = null;
  var POLL_INTERVAL_MS = 5000;

  // --- Helpers ---

  function setStatus(state, text) {
    statusPill.className = 'status' + (state ? ' ' + state : '');
    statusText.textContent = text;
  }

  function setCallId(callId) {
    callIdDisplay.textContent = callId ? 'Call ID: ' + callId : '';
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function showError(message) {
    errorBox.innerHTML = '<div class="error">' + escapeHtml(message) + '</div>';
  }

  function clearError() {
    errorBox.innerHTML = '';
  }

  function showOutcome(outcome) {
    var safe = outcome
      ? String(outcome).toUpperCase().replace(/[^A-Z_]/g, '')
      : 'UNKNOWN';
    outcomeBox.innerHTML =
      '<div class="outcome ' + safe + '">Outcome: ' + escapeHtml(safe) + '</div>';
  }

  function clearOutcome() {
    outcomeBox.innerHTML = '';
  }

  /**
   * Validate form values.
   * @returns {string|null} error message, or null if valid
   */
  function validate(name, phone, drug) {
    if (!name) {
      return 'Please enter a parent name.';
    }
    if (!drug) {
      return 'Please enter a drug name.';
    }
    if (!phone || phone.charAt(0) !== '+') {
      return 'Please enter a valid phone number (e.g., +91XXXXXXXXXX)';
    }
    return null;
  }

  // --- Polling ---

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPolling(callId) {
    stopPolling();
    pollTimer = setInterval(function () {
      pollCallStatus(callId);
    }, POLL_INTERVAL_MS);
  }

  /**
   * Poll /api/call/:callId and update the status pill.
   * Silently retries on network errors until the call ends.
   */
  function pollCallStatus(callId) {
    fetch('/api/call/' + encodeURIComponent(callId))
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var status = data.status || data.callStatus || '';

        if (status === 'queued' || status === 'ringing') {
          setStatus('calling', 'Calling...');
        } else if (status === 'in-progress') {
          setStatus('connected', 'Call connected!');
        } else if (
          status === 'ended' ||
          status === 'completed' ||
          status === 'failed'
        ) {
          stopPolling();
          var outcome =
            data.outcome ||
            (data.analysis &&
              data.analysis.structuredData &&
              data.analysis.structuredData.outcome) ||
            '';
          if (outcome) {
            setStatus('ended', 'Call ended. Outcome: ' + outcome);
            showOutcome(outcome);
          } else if (status === 'failed') {
            setStatus('error', 'Call failed');
            showError(data.error || 'The call could not be completed.');
          } else {
            setStatus('ended', 'Call ended.');
          }
        }
      })
      .catch(function () {
        // Network blip during polling — ignore and retry next interval.
      });
  }

  // --- Form submission ---

  function handleSubmit(e) {
    e.preventDefault();

    // Reset previous state
    clearError();
    clearOutcome();
    stopPolling();

    var name = document.getElementById('parentName').value.trim();
    var phone = document.getElementById('phoneNumber').value.trim();
    var drug = document.getElementById('drugName').value.trim();
    var language = document.getElementById('language').value;

    var validationError = validate(name, phone, drug);
    if (validationError) {
      setStatus('error', 'Validation error');
      showError(validationError);
      return;
    }

    // Initiate call
    callBtn.disabled = true;
    setStatus('calling', 'Calling...');
    setCallId('');

    fetch('/api/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: phone,
        name: name,
        drug: drug,
        language: language,
      }),
    })
      .then(function (res) {
        return res.json().then(
          function (body) {
            return { ok: res.ok, status: res.status, body: body };
          },
          function () {
            // Non-JSON body
            return { ok: res.ok, status: res.status, body: {} };
          }
        );
      })
      .then(function (result) {
        callBtn.disabled = false;

        if (!result.ok) {
          var msg =
            result.body.error ||
            result.body.message ||
            'Call failed (status ' + result.status + ')';
          setStatus('error', 'Call failed');
          showError(msg);
          return;
        }

        // Success — call initiated
        var callId =
          result.body.callId ||
          result.body.id ||
          result.body.call_id ||
          '';
        setStatus('calling', 'Calling...');
        if (callId) {
          setCallId(callId);
          startPolling(callId);
        }
      })
      .catch(function () {
        callBtn.disabled = false;
        setStatus('error', 'Connection error');
        showError('Could not connect to server. Is the bridge server running?');
      });
  }

  form.addEventListener('submit', handleSubmit);
})();
