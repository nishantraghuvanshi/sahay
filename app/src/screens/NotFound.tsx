import { Link } from 'react-router-dom'
import { Button, Card, Label } from '../ui'

/**
 * A stranger lands here by mistyping a handoff link far more often than a caregiver does
 * by mistyping a route — so the copy leads with that case rather than with app navigation.
 */
export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-3 py-10">
      <Card className="gap-3">
        <Label>Nothing here</Label>
        <h1 className="text-[17px] font-bold">This page does not exist</h1>
        <p className="text-[12px] leading-relaxed text-muted-strong">
          If you were sent a link to someone&rsquo;s care record, it may have been shortened or
          cut off by the app you opened it in. Ask whoever sent it for the full link — a working
          one looks like <span className="font-mono">/h/</span> followed by a long code.
        </p>
        <Link to="/home" className="self-start">
          <Button variant="outline">Go to the app</Button>
        </Link>
      </Card>
    </div>
  )
}
