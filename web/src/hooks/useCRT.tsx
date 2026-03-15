import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

interface CRTContextValue {
  crtEnabled: boolean
  setCRTEnabled: (enabled: boolean) => void
}

const CRTContext = createContext<CRTContextValue>({
  crtEnabled: false,
  setCRTEnabled: () => {},
})

const STORAGE_KEY = 'iris-crt-effect'

export function CRTProvider({ children }: { children: ReactNode }) {
  const [crtEnabled, setCRTEnabledState] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  })

  const setCRTEnabled = useCallback((enabled: boolean) => {
    localStorage.setItem(STORAGE_KEY, String(enabled))
    setCRTEnabledState(enabled)
  }, [])

  return (
    <CRTContext.Provider value={{ crtEnabled, setCRTEnabled }}>
      {children}
    </CRTContext.Provider>
  )
}

export function useCRT() {
  return useContext(CRTContext)
}
