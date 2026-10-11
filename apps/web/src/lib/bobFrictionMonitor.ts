import { supabase } from './supabase';

type MonitoredError = {
  kind: 'exception' | 'render_failure' | 'unhandled_rejection';
  name?: string;
  message: string;
};

let installed = false;

function stableKey(input: string) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(36);
}

export async function reportMonitoredError(error: MonitoredError) {
  const page = window.location.pathname.slice(0, 500);
  const message = error.message.trim().slice(0, 500);
  if (!message) return;
  const clientPacketKey = `runtime:${stableKey(`${page}|${error.kind}|${error.name ?? ''}|${message}`)}`;
  const sessionKey = `fcm:${clientPacketKey}`;
  if (window.sessionStorage.getItem(sessionKey)) return;
  window.sessionStorage.setItem(sessionKey, 'queued');

  const { error: invokeError } = await supabase.functions.invoke('bob-triage-report', {
    body: {
      client_packet_key: clientPacketKey,
      envelope: {
        schema_version: '1',
        before: {
          page,
          module: 'web_runtime',
          recent_actions: [`runtime_error:${error.kind}`],
        },
        during: {
          error: {
            kind: error.kind,
            name: error.name,
            message,
          },
        },
        expected: {
          user_intent: `Use ${page} without an unhandled application error`,
          expected_outcome: 'The current workflow remains usable and shows an explicit recoverable state.',
        },
      },
    },
  });
  if (invokeError) window.sessionStorage.removeItem(sessionKey);
}

export function installBobFrictionMonitor() {
  if (installed || typeof window === 'undefined') return () => {};
  installed = true;
  const onError = (event: ErrorEvent) => {
    const message = event.error instanceof Error ? event.error.message : event.message;
    const name = event.error instanceof Error ? event.error.name : 'Error';
    const kind = /dynamically imported module|chunkloaderror|module script/i.test(message) ? 'render_failure' : 'exception';
    void reportMonitoredError({ kind, name, message });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    void reportMonitoredError({
      kind: 'unhandled_rejection',
      name: reason instanceof Error ? reason.name : 'UnhandledRejection',
      message: reason instanceof Error ? reason.message : String(reason ?? 'Unhandled promise rejection'),
    });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    installed = false;
  };
}
