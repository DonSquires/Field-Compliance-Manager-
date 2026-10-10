const WRITE_OR_DESTRUCTIVE_ACTION = /^(not\s+a\s+(person|vehicle|animal)|delete|remove|destroy|approve|accept|decline|reject|resolve|acknowledge|submit|save|create|sign\s+out|log\s+out|logout|publish|send|apply|confirm|assign|claim|complete|finish|activate|deactivate|retry|generate|work\s+out|prepare|post|record|upload|import|sync|pay|export|lock|close|issue|invite|link|connect|enable|disable|start|end\s+shift|return|process|compare\s+price\s+to\s+cost|reconcile|add|promote|archive|update|run|verify|mark|check\s+now)\b/i;

export function isWriteOrDestructiveAction(label: string): boolean {
  return WRITE_OR_DESTRUCTIVE_ACTION.test(label.trim());
}