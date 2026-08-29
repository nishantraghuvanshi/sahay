// Router agent — classifies the caller's intent and dispatches to a specialist.
import { classify } from './llm.js';

const ROUTES = ['booking', 'triage', 'billing', 'other'];

export async function route(transcript, ctx) {
  const intent = await classify(transcript, ROUTES);
  ctx.intent = intent;
  return intent;
}
