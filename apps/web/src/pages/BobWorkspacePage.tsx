import { useNavigate } from 'react-router-dom';
import { BobPanel } from '../components/BobPanel';

/** Bob's primary operating surface. Domain pages remain available through navigation and Bob's governed tools. */
export default function BobWorkspacePage({ returnPath = '/admin/hub' }: { returnPath?: string }) {
  const navigate = useNavigate();

  return (
    <>
      <h1 className="sr-only">Bob agent workspace</h1>
      <BobPanel
        open
        onClose={() => navigate(returnPath)}
        context={{
          page: 'bob',
          workspace: 'agent command center',
          operating_model: 'research, plan, verify, propose, approve',
        }}
      />
    </>
  );
}
