/**
 * Host-side gcloud CLI runner.
 *
 * Runs `gcloud` on the host using the user's ADC or service-account credentials.
 * Credentials never enter the container — the container asks for a command via
 * IPC, the host validates and executes, and the result comes back.
 *
 * Command validation enforces a read-only posture as defense in depth; the user
 * is expected to also scope the underlying service account to read-only IAM.
 */
import { execFile } from 'node:child_process';

export interface GcloudCommandInput {
  command: readonly string[]; // args after "gcloud", e.g. ["run", "services", "list"]
  projectId?: string;
}

export interface GcloudCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const SAFE_VERBS = new Set([
  'list',
  'describe',
  'read',
  'get',
  'search',
  'history',
  'show',
  'logs',
  'info',
  'check',
  'lookup',
  'get-value',
  'get-iam-policy',
  'list-available',
  'list-grantable-roles',
]);

const UNSAFE_VERBS = new Set([
  'create',
  'delete',
  'deploy',
  'update',
  'patch',
  'set',
  'remove',
  'disable',
  'enable',
  'replace',
  'import',
  'export',
  'submit',
  'call',
  'deny',
  'grant',
  'revoke',
  'add',
  'set-iam-policy',
  'add-iam-policy-binding',
  'remove-iam-policy-binding',
  'destroy',
  'kill',
  'stop',
  'start',
  'restart',
  'abandon',
  'cancel',
  'undelete',
  'purge',
  'upgrade',
  'rollback',
  'detach',
  'attach',
  'login',
  'logout',
  'activate',
  'deactivate',
  'reset',
  'clear',
  'print-access-token',
  'print-identity-token',
  'access',
]);

// Command paths that are exfiltration risks even on read-only accounts.
// Each entry is a sequence that must all appear (in any order) as positional args.
const BLOCKED_PATHS: readonly (readonly string[])[] = [
  ['secrets', 'versions', 'access'],
  ['auth', 'print-access-token'],
  ['auth', 'print-identity-token'],
];

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export function validateGcloudCommand(
  command: readonly string[],
): ValidationResult {
  if (command.length === 0) return { ok: false, reason: 'empty command' };

  // Strip a leading "gcloud" if the caller included it.
  const args = command[0] === 'gcloud' ? command.slice(1) : [...command];
  if (args.length === 0) {
    return { ok: false, reason: 'no gcloud subcommand' };
  }

  const positional = args.filter((a) => !a.startsWith('-'));
  const positionalLower = positional.map((p) => p.toLowerCase());

  const hasSafeVerb = positionalLower.some((a) => SAFE_VERBS.has(a));
  if (!hasSafeVerb) {
    return {
      ok: false,
      reason: `no read-only verb found (allowed: ${[...SAFE_VERBS].sort().join(', ')})`,
    };
  }

  for (const a of positionalLower) {
    if (UNSAFE_VERBS.has(a)) {
      return {
        ok: false,
        reason: `blocked verb "${a}" — only read-only operations allowed`,
      };
    }
  }

  for (const blocked of BLOCKED_PATHS) {
    if (blocked.every((b) => positionalLower.includes(b))) {
      return {
        ok: false,
        reason: `blocked command path "${blocked.join(' ')}" — exfiltration risk`,
      };
    }
  }

  // Block flags that could override identity or impersonate other principals.
  for (const a of args) {
    if (a.startsWith('--impersonate-service-account')) {
      return { ok: false, reason: 'service-account impersonation not allowed' };
    }
    if (a.startsWith('--credential-file-override')) {
      return { ok: false, reason: 'credential override not allowed' };
    }
    if (a === '--account' || a.startsWith('--account=')) {
      return { ok: false, reason: 'account override not allowed' };
    }
  }

  return { ok: true };
}

export async function runGcloudCommand(
  input: GcloudCommandInput,
  timeoutMs = 60_000,
): Promise<GcloudCommandResult> {
  const validation = validateGcloudCommand(input.command);
  if (!validation.ok) {
    throw new Error(validation.reason);
  }

  const stripped =
    input.command[0] === 'gcloud' ? input.command.slice(1) : [...input.command];
  const finalArgs = input.projectId
    ? [...stripped, `--project=${input.projectId}`]
    : stripped;

  return new Promise((resolve, reject) => {
    execFile(
      'gcloud',
      finalArgs,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const stdoutStr = stdout.toString();
        const stderrStr = stderr.toString();

        if (err) {
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean })
            .killed;
          if (killed) {
            reject(new Error(`gcloud timed out after ${timeoutMs}ms`));
            return;
          }
          // Non-zero exit is common (e.g. not-found) — return it as a result,
          // not a throw, so the agent can see what gcloud said.
          const code = (
            err as NodeJS.ErrnoException & { code?: number | string }
          ).code;
          resolve({
            stdout: stdoutStr,
            stderr: stderrStr,
            exitCode: typeof code === 'number' ? code : 1,
          });
          return;
        }
        resolve({ stdout: stdoutStr, stderr: stderrStr, exitCode: 0 });
      },
    );
  });
}
