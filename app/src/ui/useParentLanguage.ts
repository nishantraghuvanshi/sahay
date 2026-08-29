import { useCareRecord } from '../api/hooks'

/**
 * The BCP-47 tag the parent actually speaks, for the `lang` attribute on her words.
 *
 * Every verbatim quote in the app used to be hardcoded `lang="hi"`. That is two lies for
 * any parent who is not a Hindi speaker: `index.css` binds `:lang(hi)` to IBM Plex Sans
 * Devanagari, so the quote sets in the wrong face, and a screen reader switches to a Hindi
 * voice mid-sentence — on the one piece of text in this product that must be reproduced
 * exactly. The record has carried `patient.language` all along (`'hi-IN'` in the seed);
 * nothing was reading it.
 *
 * `:lang(hi)` matches `hi-IN` by prefix, so the Devanagari binding is unchanged for the
 * parents who were already right. The fallback keeps the previous behaviour while the
 * record is still loading rather than flashing a different face when it lands.
 */
export function useParentLanguage(): string {
  const { data } = useCareRecord()
  return data?.patient.language || 'hi'
}
