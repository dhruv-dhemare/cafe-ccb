import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

const resetScrollPosition = () => {
  window.scrollTo(0, 0)
  document.documentElement.scrollTop = 0
  document.body.scrollTop = 0
}
if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'
resetScrollPosition()
window.addEventListener('pageshow', resetScrollPosition)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
