import { usePersonSearchAccess } from '../hooks/usePersonSearchAccess';
import PersonSearchPage from './PersonSearchPage';

export default function OfficerPersonSearchPage() {
  const access = usePersonSearchAccess();
  if (access.allowed) return <PersonSearchPage officer />;
  return <main className="page-container">
    <h1>Person search</h1>
    {access.loading ? <p role="status">Checking person-search authorization...</p> : <>
      {access.error ? <p role="alert">{access.error}</p> : <p>Your administrator must enable Person search in your user access settings before you can check people, trespass notices and permits. NZTA authorization is separate.</p>}
      <button type="button" className="btn btn-secondary" onClick={access.retry}>Check access again</button>
    </>}
  </main>;
}
