import React, { useEffect, useState } from 'react';
import { approvalMeaning, summarizeSpecification, type PlainPlanSummary } from '../lib/builderApprovalSummary';
import './BuilderApprovalBrief.css';

interface Props {
  jobId: string;
  approvalType: string;
  artifacts: Array<{ id: string; artifact_type: string }>;
  readArtifact: (jobId: string, artifactId: string) => Promise<string>;
}

function Lines({ items }: { items: string[] }) {
  return items.length === 0 ? <p className="approval-brief-none">Not stated.</p> : <ul>{items.map(item => <li key={item}>{item}</li>)}</ul>;
}

export function BuilderApprovalBrief({ jobId, approvalType, artifacts, readArtifact }: Props) {
  const meaning = approvalMeaning(approvalType);
  const specificationId = artifacts.find(artifact => artifact.artifact_type === 'product_specification')?.id ?? null;
  const [state, setState] = useState<{ loading: boolean; summary: PlainPlanSummary | null; error: string | null }>({ loading: Boolean(specificationId), summary: null, error: null });

  useEffect(() => {
    if (!specificationId) { setState({ loading: false, summary: null, error: null }); return; }
    let cancelled = false;
    setState({ loading: true, summary: null, error: null });
    readArtifact(jobId, specificationId)
      .then(content => { if (!cancelled) setState({ loading: false, summary: summarizeSpecification(content), error: null }); })
      .catch(error => { if (!cancelled) setState({ loading: false, summary: null, error: error instanceof Error ? error.message : 'The plan could not be loaded.' }); });
    return () => { cancelled = true; };
  }, [jobId, specificationId, readArtifact]);

  const summary = state.summary;
  return (
    <div className="approval-brief">
      <h4>{meaning.question}</h4>
      <div className="approval-brief-outcomes">
        <p><strong>Approve:</strong> {meaning.approveMeans}</p>
        <p><strong>Reject:</strong> {meaning.rejectMeans}</p>
      </div>
      {state.loading && <p role="status">Loading Bob's plan in plain language…</p>}
      {state.error && <p className="approval-brief-error" role="alert">{state.error} Open the evidence tab to read the raw plan.</p>}
      {specificationId && !state.loading && !state.error && !summary && <p className="approval-brief-error">Bob's plan is not in a readable format. Open the evidence tab to read it before deciding.</p>}
      {summary && <>
        <section aria-label="What Bob plans to do">
          <h5>What Bob plans to do</h5>
          {summary.problem && <p><strong>Problem:</strong> {summary.problem}</p>}
          {summary.outcome && <p><strong>Result:</strong> {summary.outcome}</p>}
          {summary.scope.length > 0 && <Lines items={summary.scope} />}
        </section>
        <section aria-label="How the change flows">
          <h5>How it works</h5>
          <ol className="approval-brief-flow">
            <li><span>Before</span><Lines items={summary.before} /></li>
            <li><span>While using it</span><Lines items={summary.during} /></li>
            <li><span>After</span><Lines items={summary.after} /></li>
          </ol>
        </section>
        <section aria-label="How you will check it">
          <h5>How you will check it</h5>
          {(summary.howYouWillCheck.role || summary.howYouWillCheck.route) && <p>{[summary.howYouWillCheck.role && `As ${summary.howYouWillCheck.role}`, summary.howYouWillCheck.route && `open ${summary.howYouWillCheck.route}`].filter(Boolean).join(', ')}.</p>}
          {summary.howYouWillCheck.steps.length > 0 && <ol>{summary.howYouWillCheck.steps.map(step => <li key={step}>{step}</li>)}</ol>}
          {summary.howYouWillCheck.result && <p><strong>You should see:</strong> {summary.howYouWillCheck.result}</p>}
        </section>
        {summary.whoFor.length > 0 && <section aria-label="Who it is for"><h5>Who it is for</h5><Lines items={summary.whoFor} /></section>}
        <section aria-label="Files Bob found">
          <h5>Files Bob found and plans to change</h5>
          {summary.files.length === 0 ? <p className="approval-brief-none">Bob has not named files yet; he searches the repository during the build.</p> : <ul className="approval-brief-files">{summary.files.map(file => <li key={file}><code>{file}</code></li>)}</ul>}
        </section>
        {(summary.questions.length > 0 || summary.assumptions.length > 0) && <section aria-label="Open questions and assumptions" className="approval-brief-questions">
          <h5>Check these before approving</h5>
          {summary.questions.length > 0 && <><p><strong>Bob's open questions</strong></p><Lines items={summary.questions} /></>}
          {summary.assumptions.length > 0 && <><p><strong>Bob's assumptions</strong></p><Lines items={summary.assumptions} /></>}
        </section>}
      </>}
    </div>
  );
}
