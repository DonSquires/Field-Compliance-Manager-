const functionNames = {
  createJob: 'wf-create-job',
  transitionJobState: 'wf-transition-job-state',
  pickupRun: 'wf-service-pickup-run',
  returnArtifact: 'wf-service-return-artifact',
  approveJob: 'wf-approve-job',
  recordPromotion: 'wf-record-promotion'
};

function createWorkflowClient({ url, serviceRoleKey, mode = 'local', fetchImpl = fetch }) {
  const enabled = mode === 'remote';
  if (enabled && (!url || !serviceRoleKey)) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in remote workflow mode');
  }

  async function invoke(operation, payload) {
    if (!enabled) return null;
    const functionName = functionNames[operation];
    const response = await fetchImpl(`${url.replace(/\/$/, '')}/functions/v1/${functionName}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { error: text };
    }
    if (!response.ok) {
      throw new Error(`Supabase ${functionName} failed (${response.status}): ${body?.error || 'unknown error'}`);
    }
    return body;
  }

  return {
    enabled,
    createJob: payload => invoke('createJob', payload),
    transitionJobState: payload => invoke('transitionJobState', payload),
    pickupRun: payload => invoke('pickupRun', payload),
    returnArtifact: payload => invoke('returnArtifact', payload),
    approveJob: payload => invoke('approveJob', payload),
    recordPromotion: payload => invoke('recordPromotion', payload)
  };
}

module.exports = { createWorkflowClient };
