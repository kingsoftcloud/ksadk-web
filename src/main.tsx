import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { ToastContainer } from './components/ToastContainer.tsx'
import { DemoWorkbench } from './demo/DemoWorkbench.tsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    {import.meta.env.VITE_DEMO_MODE === '1' ? <DemoWorkbench /> : <App />}
    <ToastContainer />
  </ErrorBoundary>,
)
