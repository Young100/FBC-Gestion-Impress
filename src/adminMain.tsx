import { createRoot } from 'react-dom/client';
import AdminApp from './AdminApp.tsx';
import './index.css';

if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/fbcprintgestionadmin/sw.js', { scope: '/fbcprintgestionadmin/' })
      .catch((err) => {
        console.warn('Atelier SW registration skipped:', err);
      });
  });
}

createRoot(document.getElementById('root')!).render(<AdminApp />);
