import React from 'react'
import './browser-bridge'
import { createRoot } from 'react-dom/client'
import CaseboardApp from './CaseboardApp'
import './caseboard.css'

document.documentElement.lang = 'zh-Hant'

createRoot(document.getElementById('caseboard-root')!).render(<React.StrictMode><CaseboardApp /></React.StrictMode>)
