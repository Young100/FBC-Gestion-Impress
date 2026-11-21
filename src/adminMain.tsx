import { registerSW } from 'virtual:pwa-register';
import { createRoot } from 'react-dom/client';
import AdminApp from './AdminApp.tsx';
import './index.css';

registerSW({ immediate: true });

createRoot(document.getElementById('root')!).render(<AdminApp />);
