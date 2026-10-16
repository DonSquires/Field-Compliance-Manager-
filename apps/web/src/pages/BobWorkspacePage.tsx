import { useLocation, useNavigate } from 'react-router-dom';
import { BobPanel } from '../components/BobPanel';

interface BobWorkspaceLocationState {
  bobSourceContext?: Record<string, unknown>;
  bobReturnPath?: string;
}

function safeReturnPath(value: unknown) {
  return typeof value === 'string' && value.startsWith('/admin/') && !value.startsWith('//')
    ? value
    : '/admin/hub';
}

/** Bob's primary operating surface. Domain pages remain available through navigation and Bob's governed tools. */
export default function BobWorkspacePage({ returnPath }: { returnPath?: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = location.state as BobWorkspaceLocationState | null;
  const sourceContext = locationState?.bobSourceContext && typeof locationState.bobSourceContext === 'object'
    ? locationState.bobSourceContext
    : {};
  const resolvedReturnPath = safeReturnPath(returnPath ?? locationState?.bobReturnPath);

  return (
    <div className="bob-standalone-workspace">
      <h1 className="sr-only">Bob agent workspace</h1>
      <BobPanel
        open
        presentation="docked"
        onClose={() => navigate(resolvedReturnPath)}
        context={{
          page: 'bob',
          workspace: 'agent command center',
          operating_model: 'research, plan, verify, propose, approve',
          ...sourceContext,
        }}
      />
    </div>
  );
}
