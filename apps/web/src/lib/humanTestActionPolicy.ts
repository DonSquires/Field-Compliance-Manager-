const WRITE_OR_DESTRUCTIVE_ACTION = /^(not\s+a\s+(person|vehicle|animal)|sos|delete|remove|destroy|approve|accept|decline|reject|resolve|acknowledge|submit|save|create|register|sign\s+out|log\s+out|logout|publish|send|apply|confirm|assign|claim|complete|finish|activate|deactivate|retry|generate|work\s+out|prepare|post|record|upload|import|sync|pay|export|download|print|lock|close|issue|invite|link|connect|enable|disable|start|end\s+(shift|access)|revoke|request|check\s+in|clock\s+(in|out)|scan|move|rename|copy|open\s+source\s+file|return|process|compare\s+price\s+to\s+cost|reconcile|add|promote|archive|update|run|verify|mark|check\s+now)\b/i;
const TOGGLE_STATE_LABEL = /(?:^|:)\s*(on|off)$/i;
const SPECIALIZED_READ_ACTION = /^(?:suggest\s+(?:a\s+)?(?:boundary\s+)?from\s+linz|find\s+linz\s+boundary)$/i;

export function isWriteOrDestructiveAction(label: string): boolean {
  const normalized = label.trim();
  return WRITE_OR_DESTRUCTIVE_ACTION.test(normalized)
    || TOGGLE_STATE_LABEL.test(normalized)
    || SPECIALIZED_READ_ACTION.test(normalized);
}