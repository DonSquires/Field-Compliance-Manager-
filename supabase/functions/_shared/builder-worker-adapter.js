/**
 * builder-worker-adapter.js
 *
 * Isolated worker execution layer for Builder Job System
 * Enforces:
 * - Command allowlisting (no dangerous patterns)
 * - Secret redaction (env vars, API keys, tokens)
 * - Resource limits (CPU, memory, disk, timeout)
 * - Non-root execution (privilege isolation)
 * - Artifact capture (stdout/stderr, outputs)
 * - Deterministic input hashing for idempotency (Layer 6)
 *
 * Does NOT execute directly; returns prepared execution plan for:
 * - Docker container spawning (via docker-compose or podman)
 * - Kubernetes pod submission
 * - Sandbox/firecracker isolation
 */

/**
 * Command patterns that must never be allowed in worker execution
 * These are OS/infrastructure destructive patterns
 */
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\s+\//, // rm -rf /
  /\bmkfs/, // mkfs (format filesystem)
  /\bdd\s+of=/, // dd of= (raw disk write)
  /\bsudo\b/, // sudo elevation
  /\bsu\b/, // su elevation
  /\bdoas\b/, // doas elevation
  /\bchmod\s+\+s/, // setuid
  /\bcurl.*[|]\s*sh/, // curl piped to shell
  /\bwget.*[|]\s*sh/, // wget piped to shell
  /\bwget.*-O.*-\s*[|]/, // wget to stdout to pipe
  /\brm\s+(-[fRr]+\s+)?\/\w+/, // rm with path deletion
  /\bkill\s+-9\s+1\b/, // kill PID 1
  /pkill\s+-9\b/, // pkill -9
  /\b\.\.\//, // Directory traversal
  /\$\(.*\)/, // Command substitution (usually piped/combined)
  /`.*`/, // Backtick substitution
];

/**
 * Secret patterns to redact from logs and output
 */
const SECRET_PATTERNS = [
  /password\s*[:=]\s*[\w\-\.]+/gi, // password: value
  /token\s*[:=]\s*[\w\-\.]+/gi, // token: value
  /api[_-]?key\s*[:=]\s*[\w\-\.]+/gi, // api_key: value
  /secret\s*[:=]\s*[\w\-\.]+/gi, // secret: value
  /authorization\s*[:=]\s*Bearer\s+[\w\-\.]+/gi, // Bearer token
  /x-api-key\s*[:=]\s*[\w\-\.]+/gi, // x-api-key header
];

/**
 * Environment variables that are commonly credentials and should be redacted
 */
const SENSITIVE_ENV_VARS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_PAT',
  'GITLAB_TOKEN',
  'GITEA_TOKEN',
  'NPM_TOKEN',
  'DOCKER_PASSWORD',
  'REGISTRY_PASSWORD',
  'DATABASE_URL',
  'DATABASE_PASSWORD',
  'API_KEY',
  'SECRET_KEY',
  'PRIVATE_KEY',
  'ENCRYPTION_KEY',
  'WEBHOOK_SECRET',
  'JWT_SECRET',
  'SESSION_SECRET',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
];

/**
 * Allowed builder execution modes and their permitted commands
 * Maps builder_mode to command patterns (regex or exact)
 */
const ALLOWED_BUILDER_COMMANDS = {
  product_analyst: [
    /^node\s+/, // Node.js CLI
    /^python3?\s+/, // Python
    /^jq\s+/, // JSON processing
    /^grep\s+/, // Text search
    /^cat\s+/,
    /^head\s+/,
    /^tail\s+/,
  ],
  ux_designer: [
    /^node\s+/,
    /^npm\s+/,
    /^figma-export/,
    /^convert\s+/, // ImageMagick
    /^identify\s+/, // ImageMagick metadata
  ],
  frontend_engineer: [
    /^node\s+/,
    /^npm\s+/,
    /^pnpm\s+/,
    /^yarn\s+/,
    /^git\s+/, // Git operations
    /^tsc\s+/, // TypeScript compiler
    /^eslint\s+/,
    /^prettier\s+/,
    /^next\s+/, // Next.js CLI
    /^vite\s+/,
  ],
  backend_engineer: [
    /^node\s+/,
    /^npm\s+/,
    /^pnpm\s+/,
    /^git\s+/,
    /^docker\s+build/, // Build only, not push/run
    /^sqlc\s+/, // SQL compiler
    /^prisma\s+/, // ORM CLI
    /^knex\s+/,
  ],
  qa_security_reviewer: [
    /^node\s+/,
    /^npm\s+/,
    /^npm\s+test/, // Specifically npm test
    /^npm\s+run\s+test/,
    /^jest\s+/,
    /^mocha\s+/,
    /^nyc\s+/, // Coverage
    /^snyk\s+/, // Security scanner
    /^trivy\s+/, // Vulnerability scanner
    /^eslint\s+/,
    /^tsc\s+/, // Type check
  ],
  release_engineer: [
    /^node\s+/,
    /^npm\s+/,
    /^git\s+/,
    /^git-cliff\s+/, // Changelog generator
    /^semantic-release\s+/, // Versioning
    /^changelog-cli\s+/,
  ],
};

/**
 * Validate that a command is safe for execution
 * Returns { safe: boolean, issues: string[] }
 * @param {string} command - Full command line
 * @param {string} builderMode - Which builder mode is executing
 * @returns {Object} { safe: boolean, issues: string[] }
 */
function validateCommand(command, builderMode) {
  const issues = [];

  if (!command || typeof command !== 'string') {
    return { safe: false, issues: ['Command must be a non-empty string'] };
  }

  // Check for dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      issues.push(`Dangerous pattern detected: ${pattern.source}`);
    }
  }

  if (issues.length > 0) {
    return { safe: false, issues };
  }

  // Validate against builder mode allowlist
  const allowedPatterns = ALLOWED_BUILDER_COMMANDS[builderMode] || [];

  const isAllowed = allowedPatterns.some(pattern => {
    if (pattern instanceof RegExp) {
      return pattern.test(command);
    }
    return command === pattern;
  });

  if (!isAllowed) {
    issues.push(`Command not in allowlist for builder mode: ${builderMode}`);
    return { safe: false, issues };
  }

  return { safe: true, issues: [] };
}

/**
 * Redact secrets from text output
 * @param {string} text - Text potentially containing secrets
 * @returns {string} Redacted text
 */
function redactSecrets(text) {
  if (!text || typeof text !== 'string') return text;

  let redacted = text;

  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }

  return redacted;
}

/**
 * Redact environment variables from an object
 * @param {Object} env - Environment variables object
 * @returns {Object} Safe-to-log version with secrets redacted
 */
function redactSensitiveEnv(env) {
  if (!env || typeof env !== 'object') return {};

  const safe = {};
  for (const [key, value] of Object.entries(env)) {
    if (SENSITIVE_ENV_VARS.some(sensitive => key.toUpperCase().includes(sensitive))) {
      safe[key] = '[REDACTED]';
    } else {
      safe[key] = value;
    }
  }

  return safe;
}

/**
 * Build an isolated worker execution plan
 * Returns Docker/container spec without executing
 * @param {Object} params - { builderMode, command, workingDir, environment, timeout, resourceLimits }
 * @returns {Object|null} Execution plan or null if validation fails
 */
function buildWorkerExecutionPlan({
  builderMode,
  command,
  workingDir = '/workspace',
  environment = {},
  timeout = 3600,
  resourceLimits = {}
}) {
  // Validate command safety
  const validation = validateCommand(command, builderMode);
  if (!validation.safe) {
    return null;
  }

  // Extract sensitive env var count for audit
  const sensitiveCount = Object.keys(environment).filter(k =>
    SENSITIVE_ENV_VARS.some(s => k.toUpperCase().includes(s))
  ).length;

  // Default resource limits per builder mode
  const limits = {
    cpuLimitMillis: resourceLimits.cpuLimitMillis || 2000, // 2 CPU cores
    memoryLimitMb: resourceLimits.memoryLimitMb || 2048, // 2GB
    diskLimitMb: resourceLimits.diskLimitMb || 5120, // 5GB
    ...resourceLimits
  };

  return {
    // Execution spec
    command,
    working_directory: workingDir,
    timeout_seconds: Math.min(timeout, 3600), // Cap at 1 hour

    // Environment safety
    environment_vars_redacted_count: sensitiveCount,
    environment_vars_safe: redactSensitiveEnv(environment),
    environment_vars_sensitive_count: sensitiveCount,

    // Resource isolation
    resource_limits: limits,

    // Container spec (Docker/Podman)
    container: {
      image: getBuilderImage(builderMode),
      user: '1000:1000', // Non-root
      read_only_root_filesystem: true,
      security_options: [
        'no-new-privileges:true',
        'cap-drop=ALL', // Drop all capabilities
        'cap-add=NET_BIND_SERVICE', // Allow only if needed
      ],
      volumes: [
        {
          source: '/workspace',
          destination: '/workspace',
          read_only: false,
        },
        {
          source: '/tmp',
          destination: '/tmp',
          read_only: false,
        },
      ],
      tmpfs: [
        {
          destination: '/tmp',
          size_mb: limits.diskLimitMb / 2,
          mode: '1777',
        },
      ],
    },

    // Bob's worker bridge network (owner ruling 2026-10-21): tailnet reachable, governed by the
    // BOB-WORKER-EGRESS firewall chain; BOB_WORKER_NETWORK=none on the host restores offline runs.
    network: 'bob-workers',

    // Artifact capture
    capture_stdout: true,
    capture_stderr: true,
    max_output_size_mb: 50,

    // Safety checks
    command_validation_passed: true,
    dangerous_patterns_found: [],

    // Execution mode
    isolation_level: 'container', // or 'vm', 'sandbox'
    log_redaction_enabled: true,
  };
}

/**
 * Get appropriate builder image for a builder mode
 * @param {string} builderMode - Builder mode
 * @returns {string} Docker image reference
 */
function getBuilderImage(builderMode) {
  const images = {
    product_analyst: 'node:24-alpine', // Node for analysis scripts
    ux_designer: 'node:24-alpine', // Node + figma tools
    frontend_engineer: 'node:24-alpine', // Node for npm builds
    backend_engineer: 'node:24-alpine', // Node for backend builds
    qa_security_reviewer: 'node:24-alpine', // Node for test runners
    release_engineer: 'node:24-alpine', // Node for release tools
  };

  return images[builderMode] || 'node:24-alpine';
}

/**
 * Analyze execution result and extract evidence
 * Does NOT execute; prepares analysis template
 * @param {Object} workerRun - Worker run with stdout/stderr/exit_code
 * @param {string} builderMode - Which builder mode produced this
 * @returns {Object} Evidence and artifact references
 */
function analyzeWorkerOutput(workerRun, builderMode) {
  if (!workerRun) return {};

  const analysis = {
    exit_code: workerRun.exit_code,
    output_size_bytes: (workerRun.stdout || '').length + (workerRun.stderr || '').length,
    secrets_redacted_count: workerRun.secrets_redacted_count || 0,

    // Safe output for archiving
    stdout_redacted: redactSecrets(workerRun.stdout || ''),
    stderr_redacted: redactSecrets(workerRun.stderr || ''),

    // Evidence extraction (mode-specific)
    evidence: extractEvidenceFromOutput(workerRun, builderMode),

    // Status classification
    status: workerRun.exit_code === 0 ? 'success' : 'failed',
    timeout: workerRun.timeout || false,
  };

  return analysis;
}

/**
 * Extract evidence from worker output based on builder mode
 * @param {Object} workerRun - Execution result
 * @param {string} builderMode - Builder mode
 * @returns {Array<Object>} Evidence array
 */
function extractEvidenceFromOutput(workerRun, builderMode) {
  const evidence = [];

  if (workerRun.exit_code !== 0) {
    evidence.push({
      type: 'execution_failed',
      exit_code: workerRun.exit_code,
      stderr_preview: (workerRun.stderr || '').substring(0, 200),
    });
    return evidence;
  }

  // Mode-specific evidence extraction
  if (builderMode === 'qa_security_reviewer') {
    // Parse test output for pass/fail counts
    const testMatch = (workerRun.stdout || '').match(/(\d+)\s+passing|(\d+)\s+failing/g);
    if (testMatch) {
      evidence.push({
        type: 'test_run_summary',
        test_lines: testMatch,
      });
    }
  }

  if (builderMode === 'frontend_engineer' || builderMode === 'backend_engineer') {
    // Check for build artifacts
    if ((workerRun.stdout || '').includes('successfully')) {
      evidence.push({
        type: 'build_success',
        output_preview: (workerRun.stdout || '').substring(0, 300),
      });
    }
  }

  return evidence;
}

export {
  DANGEROUS_PATTERNS,
  SECRET_PATTERNS,
  SENSITIVE_ENV_VARS,
  ALLOWED_BUILDER_COMMANDS,
  validateCommand,
  redactSecrets,
  redactSensitiveEnv,
  buildWorkerExecutionPlan,
  getBuilderImage,
  analyzeWorkerOutput,
  extractEvidenceFromOutput,
};
