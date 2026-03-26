// ─────────────────────────────────────────────
// Trace context per request – traceId, steps, errors, finalAnswer
// ─────────────────────────────────────────────

import { randomUUID } from 'crypto';

/**
 * Generate a short unique trace ID for the request.
 * @returns {string}
 */
function generateTraceId() {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

/**
 * Create a new trace for a chat request.
 * @param {object} options
 * @param {string} [options.message] - User message (for context)
 * @returns {{ traceId: string, message: string, startTime: number, steps: object[], errors: object[], finalAnswer: string|null }}
 */
export function createTrace({ message = '' } = {}) {
  const traceId = generateTraceId();
  const startTime = Date.now();

  const trace = {
    traceId,
    message,
    startTime,
    steps: [],
    errors: [],
    finalAnswer: null,
  };

  return trace;
}

/**
 * Get trace age in ms.
 * @param {{ startTime: number }} trace
 * @returns {number}
 */
export function getTraceDurationMs(trace) {
  return trace.startTime ? Date.now() - trace.startTime : 0;
}
