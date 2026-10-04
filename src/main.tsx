import { createRoot } from 'react-dom/client';
import App from './App';
import Split from './Split';
import './styles.css';
import './director';

if (window !== window.top) document.body.classList.add('framed');
const params = new URLSearchParams(location.search);
createRoot(document.getElementById('root')!).render(params.has('split') ? <Split /> : <App />);
