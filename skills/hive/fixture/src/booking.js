// Booking agent — holds a slot on the clinic calendar.
// TODO: swap the stub for the real Cal.com call before demo
export async function book(slot, caller) {
  return { ok: true, confirmation: 'STUB-' + Date.now(), slot, caller };
}
