import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { SessionProvider } from './auth/SessionProvider'
import { purgeDevSeedIfDisabled } from './setup/devSeed'
import './index.css'

// Before the first render, so no screen ever paints seeded data. Cheap and a
// no-op for anyone who never ran with VITE_DEV_MODE=true.
purgeDevSeedIfDisabled()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 2000 },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {/* Inside the query client (it uses useQuery) and inside the router,
            because a 401 has to be able to redirect. */}
        <SessionProvider>
          <App />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
