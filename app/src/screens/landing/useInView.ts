import { useEffect, useRef, useState } from 'react'

/**
 * Reports when an element first enters the viewport.
 *
 * Deliberately one-shot: the four feature panels are a sequence the reader
 * walks through once, not something that should re-perform on every scroll
 * back up.
 */
export function useInView({ threshold = 0.12 }: { threshold?: number } = {}) {
  const ref = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return undefined

    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return undefined
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        setInView(true)
        observer.disconnect()
      },
      { threshold },
    )

    observer.observe(node)
    return () => observer.disconnect()
  }, [threshold])

  return [ref, inView] as const
}
