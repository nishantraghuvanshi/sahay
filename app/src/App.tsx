import { Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './shell/AppShell'
import Placeholder from './screens/Placeholder'
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

/**
 * Routing skeleton for every screen, empty for now (LANE-C-APP.md scaffold step).
 * Wireframe id in brackets — mobile / web.
 *
 * Setup, handoff and login render outside the shell: no tab bar, no sidebar.
 */
export default function App() {
  return (
    <Routes>
      {/* auth + onboarding — no shell chrome */}
      <Route path="/login" element={<Login />} />
      <Route path="/setup">
        <Route path="parent" element={<Parent />} />
        <Route path="prescription" element={<Prescription />} />
        <Route path="analysing" element={<Analysing />} />
        <Route path="schedule" element={<Schedule />} />
        <Route path="consent" element={<Consent />} />
      </Route>

      {/* handoff — no login, no chrome, its own layout (TRD §11) */}
      <Route path="/h/:token" element={<Placeholder title="Handoff record" frame="TRD §11" />} />

      {/* the four tabs + everything reachable from them */}
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/home" replace />} />
        <Route path="/home" element={<Home />} />
        <Route path="/calendar" element={<Placeholder title="Calendar" frame="1g / 2f" />} />
        <Route path="/medicines/edit" element={<Placeholder title="Change medicines" frame="1G.2 / 2F.2" />} />
        <Route path="/alerts" element={<Placeholder title="Alerts" frame="1h / 2g" />} />
        <Route path="/alerts/:id" element={<Placeholder title="Alert detail" frame="1i / 2g" />} />
        <Route path="/calls" element={<Placeholder title="Calls" frame="1j / 2h" />} />
        <Route path="/calls/:id" element={<Placeholder title="Call detail" frame="1j / 2h" />} />
        <Route path="/record" element={<CareRecord />} />
        <Route path="/doses" element={<DoseHistory />} />
        <Route path="/observations" element={<Observations />} />
        <Route path="/settings" element={<Placeholder title="Settings" frame="1m / 2k" />} />
        {/* dev-only review surface, removed before the freeze */}
        <Route path="/kitchen-sink" element={<KitchenSink />} />
      </Route>

      <Route path="*" element={<Placeholder title="Not found" frame="404" />} />
    </Routes>
  )
}
