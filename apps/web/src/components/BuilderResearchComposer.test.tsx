import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BuilderResearchComposer } from './BuilderResearchComposer';

const { rpc, getUser, upload, invoke } = vi.hoisted(() => ({
  rpc: vi.fn(), getUser: vi.fn(), upload: vi.fn(), invoke: vi.fn(),
}));
vi.mock('../lib/supabase', () => ({ supabase: {
  rpc, auth: { getUser }, storage: { from: () => ({ upload }) }, functions: { invoke },
} }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const consent = /I reviewed this question/;
function setup(question = 'Public Docker Compose research') {
  getUser.mockResolvedValue({ data: { user: { id: 'test-owner' } }, error: null });
  rpc.mockResolvedValue({ data: 'research-message', error: null });
  const props = { threadId: 'test-thread', question, disabled: false, onSent: vi.fn(), onError: vi.fn(), onBusy: vi.fn() };
  return { ...render(<BuilderResearchComposer {...props} />), props };
}

it('requires fresh explicit approval and sends only the approved question, never page/history context', async () => {
  const { props } = setup();
  const send = screen.getByRole('button', { name: 'Send approved cloud research' }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(consent));
  fireEvent.click(send);
  await waitFor(() => expect(props.onSent).toHaveBeenCalledOnce());
  expect(rpc).toHaveBeenCalledWith('builder_chat_send_research', {
    p_thread_id: 'test-thread', p_content: props.question, p_client_request_id: expect.any(String),
    p_files: [], p_urls: [], p_web_search: true, p_allow_cloud: true,
  });
  expect((screen.getByLabelText(consent) as HTMLInputElement).checked).toBe(false);
  expect(props.onBusy.mock.calls).toEqual([[true], [false]]);
});

it('invalidates approval when question, sources or search selection changes', () => {
  const { rerender, props } = setup();
  const approve = () => fireEvent.click(screen.getByLabelText(consent));
  const checked = () => (screen.getByLabelText(consent) as HTMLInputElement).checked;
  approve();
  rerender(<BuilderResearchComposer {...props} question="Another public question" />);
  expect(checked()).toBe(false);
  approve();
  fireEvent.change(screen.getByLabelText(/Source URLs/), { target: { value: 'https://docs.docker.com/compose/' } });
  expect(checked()).toBe(false);
  approve();
  fireEvent.click(screen.getByLabelText('Search the public web'));
  expect(checked()).toBe(false);
});

it('blocks unsafe URL submissions and unsupported or excessive files before upload', async () => {
  const { props } = setup();
  fireEvent.change(screen.getByLabelText(/Source URLs/), { target: { value: 'https://docs.docker.com/?token=secret' } });
  fireEvent.click(screen.getByLabelText(consent));
  fireEvent.click(screen.getByRole('button', { name: 'Send approved cloud research' }));
  await waitFor(() => expect(props.onError).toHaveBeenCalledWith(expect.stringMatching(/query strings/)));
  expect(rpc).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Research attachments'), { target: { files: [new File(['bad'], 'binary.exe')] } });
  expect(props.onError).toHaveBeenCalledWith(expect.stringMatching(/unsupported/));
  fireEvent.change(screen.getByLabelText('Research attachments'), { target: { files: Array.from({ length: 6 }, () => new File(['test'], 'safe.txt', { type: 'text/plain' })) } });
  expect(props.onError).toHaveBeenCalledWith('Attach up to five research files.');
  expect(upload).not.toHaveBeenCalled();
});

it('keeps a stable request id across uncertain network failures and surfaces the error', async () => {
  rpc.mockRejectedValue(new Error('Network response lost'));
  const { props, rerender } = setup();
  rpc.mockRejectedValue(new Error('Network response lost'));
  fireEvent.click(screen.getByLabelText(consent));
  fireEvent.click(screen.getByRole('button', { name: 'Send approved cloud research' }));
  await waitFor(() => expect(props.onError).toHaveBeenCalledWith('Network response lost'));
  fireEvent.click(screen.getByRole('button', { name: 'Send approved cloud research' }));
  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
  expect(rpc.mock.calls[0][1].p_client_request_id).toBe(rpc.mock.calls[1][1].p_client_request_id);
  await waitFor(() => expect(props.onBusy).toHaveBeenLastCalledWith(false));
  rerender(<BuilderResearchComposer {...props} question="Changed after an uncertain submission" />);
  expect((screen.getByLabelText(consent) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByLabelText(consent));
  fireEvent.click(screen.getByRole('button', { name: 'Send approved cloud research' }));
  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(3));
  expect(rpc.mock.calls[2][1].p_client_request_id).toBe(rpc.mock.calls[0][1].p_client_request_id);
  expect(props.onSent).not.toHaveBeenCalled();
});

function syntheticFile(name: string, type: string) {
  const bytes = new TextEncoder().encode('public synthetic fixture');
  const file = new File([bytes], name, { type });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer });
  return file;
}

it('uploads an owned scoped document, verifies extractor checksum and caps transferred text', async () => {
  const { props } = setup();
  const file = syntheticFile('public.txt', 'text/plain');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
  upload.mockResolvedValue({ error: null });
  invoke.mockResolvedValue({ data: { checksum: hash, text: 'a'.repeat(15000) }, error: null });
  fireEvent.change(screen.getByLabelText('Research attachments'), { target: { files: [file] } });
  fireEvent.click(screen.getByLabelText(consent));
  fireEvent.click(screen.getByRole('button', { name: 'Send approved cloud research' }));
  await waitFor(() => expect(props.onSent).toHaveBeenCalledOnce());
  expect(upload.mock.calls[0][0]).toMatch(/^desktop\/test-owner\/builder-chat\/test-thread\/[0-9a-f-]+-public.txt$/);
  expect(invoke).toHaveBeenCalledWith('bob-extract-document', { body: expect.objectContaining({ storage_bucket: 'bob-uploads', storage_path: upload.mock.calls[0][0] }) });
  const attachment = rpc.mock.calls[0][1].p_files[0];
  expect(attachment.sha256).toBe(hash);
  expect(attachment.extracted_text.length).toBe(12000);
  expect(attachment).not.toHaveProperty('bytes');
});

it('does not send a document whose extraction has no readable text or a different checksum', async () => {
  const { props } = setup();
  upload.mockResolvedValue({ error: null });
  invoke.mockResolvedValue({ data: { checksum: 'wrong', text: '' }, error: null });
  fireEvent.change(screen.getByLabelText('Research attachments'), { target: { files: [syntheticFile('scan.pdf', 'application/pdf')] } });
  fireEvent.click(screen.getByLabelText(consent));
  fireEvent.click(screen.getByRole('button', { name: 'Send approved cloud research' }));
  await waitFor(() => expect(props.onError).toHaveBeenCalledWith(expect.stringMatching(/no verified readable/)));
  expect(screen.getByText(/Preparation failed; retry or remove/)).toBeTruthy();
  expect(rpc).not.toHaveBeenCalled();
  expect(props.onSent).not.toHaveBeenCalled();
});
