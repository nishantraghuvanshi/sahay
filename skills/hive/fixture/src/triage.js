// Triage agent — runs the symptom protocol and returns an acuity level.
import { complete } from './llm.js';

const RED_FLAGS = ['chest pain', 'shortness of breath', 'slurred speech', 'severe bleeding'];

export async function assess(transcript, ctx) {
  const lower = transcript.toLowerCase();
  const flagged = RED_FLAGS.find(f => lower.includes(f));
  if (flagged) {
    ctx.escalated = true;
    return { acuity: 1, reason: flagged };
  }
  const out = await complete(`Assess acuity 2-5 for: ${transcript}`);
  return { acuity: Number(out.trim()) || 4, reason: 'model' };
}
