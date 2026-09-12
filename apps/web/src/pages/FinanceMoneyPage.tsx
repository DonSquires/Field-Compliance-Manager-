import { ArrowLeft } from 'lucide-react';
import { FinanceOperationsDashboard } from '../components/FinanceOperationsDashboard';
import { FinanceControlPanel } from '../components/FinanceControlPanel';
import '../components/FinanceControlPanel.css';

export default function FinanceMoneyPage({ onBack }: { onBack: () => void }) {
  return <div className="page-container"><header className="page-header"><div><button type="button" className="btn btn-secondary" onClick={onBack}><ArrowLeft size={15} /> Finance home</button><h1>How is the business doing?</h1><p className="subtitle">Bob turns the finance records into a short, plain-language money check.</p></div></header><FinanceOperationsDashboard /><FinanceControlPanel /></div>;
}
