import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ThemeProvider } from './hooks/useTheme'
import { CRTProvider } from './hooks/useCRT'
import './styles/index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <CRTProvider>
        <App />
      </CRTProvider>
    </ThemeProvider>
  </React.StrictMode>,
)
