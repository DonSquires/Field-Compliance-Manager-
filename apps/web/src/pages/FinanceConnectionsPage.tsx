import { ArrowLeft } from 'lucide-react';
import { FinanceConnectionWizard } from '../components/FinanceConnectionWizard';
import '../components/FinanceConnectionWizard.css';

export default function FinanceConnectionsPage({ onBack }: { onBack: () => void }) {
  return <div className="page-container"><header className="page-header"><div><button type="button" className="btn btn-secondary" onClick={onBack}><ArrowLeft size={15} /> Finance home</button><h1>Connect your finance accounts</h1><p className="subtitle">Bob prepares the setup. ANZ or IRD handles your login and authorisation.</p></div></header><FinanceConnectionWizard /></div>;
}
