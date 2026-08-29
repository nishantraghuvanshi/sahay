import { Navigate, Route, Routes } from 'react-router-dom'
import { DEV_MODE } from './config'
import AppShell from './shell/AppShell'
import RequireAuth from './auth/RequireAuth'
import { useSession } from './auth/SessionProvider'
import Landing from './screens/landing/Landing'
import KitchenSink from './screens/KitchenSink'
import Login from './screens/setup/Login'
import Parent from './screens/setup/Parent'
import Prescription from './screens/setup/Prescription'
import Analysing from './screens/setup/Analysing'
import Schedule from './screens/setup/Schedule'
import Consent from './screens/setup/Consent'
import Home from './screens/Home'
import CareRecord from './screens/CareRecord'
import Observations from './screens/Observations'
import DoseHistory from './screens/DoseHistory'
import Alerts from './screens/Alerts'
import Handoff from './screens/Handoff'
import AlertDetail from './screens/AlertDetail'
import Calls from './screens/Calls'
import CallDetail from './screens/CallDetail'
import Calendar from './screens/Calendar'
import MedicinesEdit from './screens/MedicinesEdit'
import NotFound from './screens/NotFound'
import Settings from './screens/Settings'

/**
 * Routing skeleton for every screen, empty for now (LANE-C-APP.md scaffold step).
 * Wireframe id in brackets — mobile / web.
 *
 * Setup, handoff and login render outside the shell: no tab bar, no sidebar.
 */
export default function App() {
  return (
    <Routes>
      {/* `/` — marketing for a signed-out visitor, a pass-through for everyone else.
          Outside AppShell and outside RequireAuth: it is the one page that has to
          render for someone with no session at all. */}
      <Route index element={<Root />} />

      {/* auth + onboarding — no shell chrome */}
      <Route path="/login" element={DEV_MODE ? <Navigate to="/setup/prescription" replace /> : <Login />} />
      {/* Onboarding writes against the signed-in caregiver, so it is behind the
          same gate as the app itself — step 2 of login is what opens it. */}
      <Route element={<RequireAuth />}>
        <Route path="/setup">
          <Route path="parent" element={<Parent />} />
          <Route path="prescription" element={<Prescription />} />
          <Route path="analysing" element={<Analysing />} />
          <Route path="schedule" element={<Schedule />} />
          <Route path="consent" element={<Consent />} />
        </Route>
      </Route>

      {/* handoff — no login, no chrome, its own layout (TRD §11) */}
      <Route path="/h/:token" element={<Handoff />} />

      {/* the four tabs + everything reachable from them */}
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/home" element={<Home />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/medicines/edit" element={<MedicinesEdit />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/alerts/:id" element={<AlertDetail />} />
          <Route path="/calls" element={<Calls />} />
          <Route path="/calls/:id" element={<CallDetail />} />
          <Route path="/record" element={<CareRecord />} />
          <Route path="/doses" element={<DoseHistory />} />
          <Route path="/observations" element={<Observations />} />
          <Route path="/settings" element={<Settings />} />
          {/* dev-only review surface — tree-shaken out of the production bundle */}
          {import.meta.env.DEV && <Route path="/kitchen-sink" element={<KitchenSink />} />}
        </Route>
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

/**
 * Signed out, `/` is the pitch. Signed in, it is a doorway — a caregiver who has
 * already onboarded should never land on marketing.
 *
 * `undefined` is "still asking /auth/me": render nothing rather than flashing the
 * landing page at someone who is perfectly signed in.
 */
function Root() {
  const session = useSession()
  if (session === undefined) return null
  if (session) return <Navigate to={DEV_MODE ? '/setup/prescription' : '/home'} replace />
  return <Landing />
}
