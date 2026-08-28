const http = require('http');
const crypto = require('crypto');

const port = Number(process.env.PORT || 8080);
const webhookSecret = process.env.GITEA_WEBHOOK_SECRET || '';
const adminToken = process.env.BOB_ADMIN_TOKEN || '';
const jobs = new Map();
const deliveries = new Set();
const audit = [];
let activeLease = null;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1024 * 1024) reject(new Error('payload too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid json')); } });
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!adminToken) return false;
  return req.headers.authorization === `Bearer ${adminToken}`;
}

function webhookValid(req, rawBody) {
  if (!webhookSecret) return false;
  const supplied = req.headers['x-gitea-signature'] || req.headers['x-hub-signature-256'] || '';
  const digest = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const expected = supplied.replace(/^sha256=/, '');
  return expected.length === digest.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(digest));
}

function record(actor, type, subject, metadata = {}) {
  const event = { id: crypto.randomUUID(), occurredAt: new Date().toISOString(), actor, type, subject, metadata };
  audit.push(event);
  return event;
}

function createJob(input, actor) {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: 'queued',
    jobType: input.jobType || 'build',
    repository: input.repository,
    ref: input.ref || 'main',
    commitSha: input.commitSha || null,
    requestedBy: actor,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    approval: null,
    verificationStatus: 'pending'
  };
  jobs.set(id, job);
  record(actor, 'job.created', id, { repository: job.repository, ref: job.ref });
  return job;
}

function route(req, res, body) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok', service: 'bob-control-plane', activeLease: Boolean(activeLease) });
  if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });

  if (req.method === 'POST' && url.pathname === '/jobs') {
    if (!body.repository) return json(res, 400, { error: 'repository is required' });
    return json(res, 201, createJob(body, 'admin'));
  }

  const match = url.pathname.match(/^\/jobs\/([^/]+)(?:\/(approve|cancel))?$/);
  if (match) {
    const job = jobs.get(match[1]);
    if (!job) return json(res, 404, { error: 'job not found' });
    if (req.method === 'GET' && !match[2]) return json(res, 200, { ...job, audit: audit.filter(event => event.subject === job.id) });
    if (req.method === 'POST' && match[2] === 'cancel') {
      if (['deployed', 'cancelled'].includes(job.status)) return json(res, 409, { error: 'job cannot be cancelled' });
      job.status = 'cancelled'; job.updatedAt = new Date().toISOString(); record('admin', 'job.cancelled', job.id); return json(res, 200, job);
    }
    if (req.method === 'POST' && match[2] === 'approve') {
      if (job.status !== 'approval_required') return json(res, 409, { error: 'job is not awaiting approval' });
      job.approval = { approver: 'admin', commitSha: body.commitSha || job.commitSha, target: body.deploymentTarget || null, at: new Date().toISOString() };
      job.status = 'approved'; job.updatedAt = new Date().toISOString(); record('admin', 'job.approved', job.id, job.approval); return json(res, 200, job);
    }
  }
  return json(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', async () => {
    try {
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === 'POST' && req.url === '/webhooks/gitea') {
        if (!webhookValid(req, raw)) return json(res, 401, { error: 'invalid webhook signature' });
        const delivery = req.headers['x-gitea-delivery'] || req.headers['x-request-id'];
        if (delivery && deliveries.has(delivery)) return json(res, 202, { accepted: true, duplicate: true });
        if (delivery) deliveries.add(delivery);
        const job = createJob({ repository: body.repository?.full_name || body.repository?.name, ref: body.ref, commitSha: body.after }, 'gitea');
        record('gitea', 'webhook.received', job.id, { delivery });
        return json(res, 202, { accepted: true, jobId: job.id });
      }
      route(req, res, body);
    } catch (error) { json(res, 400, { error: error.message }); }
  });
});

server.listen(port, '0.0.0.0', () => console.log(`bob-control-plane listening on ${port}`));