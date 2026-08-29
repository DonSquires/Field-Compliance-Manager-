export function OfficerHomePage() {
  return (
    <div style={{ padding: 24 }}>
      <h1>Officer Operations</h1>
      <p>Check your shift, welfare status, and active tasks.</p>
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <Card title="Shift" value="On duty • 07:00-17:00" />
        <Card title="Safety" value="Welfare active" />
        <Card title="Dispatch" value="3 jobs assigned" />
        <Card title="Location" value="Auckland Central" />
      </div>
    </div>
  );
}

function Card({ title, value }: { title: string; value: string }) {
  return (
    <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 12, padding: 18 }}>
      <div style={{ color: '#94a3b8', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>{title}</div>
      <div style={{ marginTop: 12, fontSize: 22, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
