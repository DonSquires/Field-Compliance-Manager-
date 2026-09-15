import { ArrowLeft } from 'lucide-react';
import { FinanceCostingPanel } from '../components/FinanceCostingPanel';

export default function FinanceCostingPage({ onBack }: { onBack: () => void }) {
  return <div className="page-container"><header className="page-header"><div><button type="button" className="btn btn-secondary" onClick={onBack}><ArrowLeft size={15} /> Finance home</button><h1>What should this job cost?</h1><p className="subtitle">Enter the facts you know. Bob calculates what the job really costs and what should be left after costs.</p></div></header><FinanceCostingPanel /></div>;
}
