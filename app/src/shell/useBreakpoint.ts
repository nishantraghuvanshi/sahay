import { useEffect, useState } from 'react'
import { DESKTOP_MIN_PX } from '../config'

/** True at desktop width — sidebar shell. False on a phone — tab bar shell. */
export function useIsDesktop(): boolean {
  const query = `(min-width: ${DESKTOP_MIN_PX}px)`
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  )

  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mql.addEventListener('change', onChange)
    setIsDesktop(mql.matches)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return isDesktop
}
