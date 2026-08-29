import { Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './shell/AppShell'
import Placeholder from './screens/Placeholder'

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
      <Route path="/login" element={<Placeholder title="Log in" frame="1a / 2a" />} />
      <Route path="/setup">
        <Route path="parent" element={<Placeholder title="Who are we caring for?" frame="1b / 2b" />} />
        <Route path="prescription" element={<Placeholder title="Add prescription" frame="1c / 2c" />} />
        <Route path="analysing" element={<Placeholder title="Reading prescription" frame="1d / 2c" />} />
        <Route path="schedule" element={<Placeholder title="Review schedule" frame="1e / 2d" />} />
        <Route path="consent" element={<Placeholder title="Before we call Mom" frame="1E.2 / 2D.2" />} />
      </Route>

      {/* handoff — no login, no chrome, its own layout (TRD §11) */}
      <Route path="/h/:token" element={<Placeholder title="Handoff record" frame="TRD §11" />} />

      {/* the four tabs + everything reachable from them */}
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/home" replace />} />
        <Route path="/home" element={<Placeholder title="Home" frame="1f / 2e" />} />
        <Route path="/calendar" element={<Placeholder title="Calendar" frame="1g / 2f" />} />
        <Route path="/medicines/edit" element={<Placeholder title="Change medicines" frame="1G.2 / 2F.2" />} />
        <Route path="/alerts" element={<Placeholder title="Alerts" frame="1h / 2g" />} />
        <Route path="/alerts/:id" element={<Placeholder title="Alert detail" frame="1i / 2g" />} />
        <Route path="/calls" element={<Placeholder title="Calls" frame="1j / 2h" />} />
        <Route path="/calls/:id" element={<Placeholder title="Call detail" frame="1j / 2h" />} />
        <Route path="/record" element={<Placeholder title="Care record" frame="FR-23" />} />
        <Route path="/doses" element={<Placeholder title="Dose history" frame="FR-24" />} />
        <Route path="/observations" element={<Placeholder title="What Mom said" frame="1s / 2j" />} />
        <Route path="/settings" element={<Placeholder title="Settings" frame="1m / 2k" />} />
      </Route>

      <Route path="*" element={<Placeholder title="Not found" frame="404" />} />
    </Routes>
  )
}
