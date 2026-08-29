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
import Alerts from './screens/Alerts'
import Handoff from './screens/Handoff'
import AlertDetail from './screens/AlertDetail'
import Calls from './screens/Calls'
import CallDetail from './screens/CallDetail'
import Calendar from './screens/Calendar'
import MedicinesEdit from './screens/MedicinesEdit'

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
      <Route path="/h/:token" element={<Handoff />} />

      {/* the four tabs + everything reachable from them */}
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/home" replace />} />
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
        <Route path="/settings" element={<Placeholder title="Settings" frame="1m / 2k" />} />
        {/* dev-only review surface, removed before the freeze */}
        <Route path="/kitchen-sink" element={<KitchenSink />} />
      </Route>

      <Route path="*" element={<Placeholder title="Not found" frame="404" />} />
    </Routes>
  )
}
