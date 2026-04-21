import { describe, it, expect } from 'vitest';

import { validateGcloudCommand } from './gcloud.js';

describe('validateGcloudCommand', () => {
  describe('allowed read-only commands', () => {
    it('allows list', () => {
      expect(validateGcloudCommand(['run', 'services', 'list'])).toEqual({
        ok: true,
      });
    });

    it('allows describe with positional resource name', () => {
      expect(
        validateGcloudCommand([
          'run',
          'services',
          'describe',
          'svc-name',
          '--region=us-central1',
        ]),
      ).toEqual({ ok: true });
    });

    it('allows logging read with filter', () => {
      expect(
        validateGcloudCommand([
          'logging',
          'read',
          'severity>=ERROR',
          '--limit=50',
          '--format=json',
        ]),
      ).toEqual({ ok: true });
    });

    it('allows compute instances list', () => {
      expect(validateGcloudCommand(['compute', 'instances', 'list'])).toEqual({
        ok: true,
      });
    });

    it('tolerates a leading "gcloud"', () => {
      expect(
        validateGcloudCommand(['gcloud', 'run', 'services', 'list']),
      ).toEqual({ ok: true });
    });

    it('allows secrets list (metadata only)', () => {
      expect(validateGcloudCommand(['secrets', 'list'])).toEqual({ ok: true });
    });

    it('allows get-iam-policy', () => {
      expect(
        validateGcloudCommand(['projects', 'get-iam-policy', 'my-project']),
      ).toEqual({ ok: true });
    });
  });

  describe('blocked mutating verbs', () => {
    it.each([
      ['delete', ['run', 'services', 'delete', 'svc']],
      ['create', ['run', 'services', 'create', 'svc']],
      ['update', ['run', 'services', 'update', 'svc']],
      ['deploy', ['run', 'deploy', 'svc']],
      ['patch', ['compute', 'instances', 'patch', 'vm']],
      ['set', ['config', 'set', 'project', 'x']],
      ['disable', ['services', 'disable', 'svc']],
      ['enable', ['services', 'enable', 'svc']],
      ['start', ['compute', 'instances', 'start', 'vm']],
      ['stop', ['compute', 'instances', 'stop', 'vm']],
      [
        'add-iam-policy-binding',
        [
          'projects',
          'add-iam-policy-binding',
          'p',
          '--member=user:a@b.com',
          '--role=roles/owner',
        ],
      ],
    ])('rejects %s', (_label, command) => {
      const result = validateGcloudCommand(command);
      expect(result.ok).toBe(false);
    });
  });

  describe('exfiltration paths', () => {
    it('rejects secrets versions access', () => {
      const result = validateGcloudCommand([
        'secrets',
        'versions',
        'access',
        'latest',
        '--secret=api-key',
      ]);
      expect(result.ok).toBe(false);
    });

    it('rejects auth print-access-token', () => {
      const result = validateGcloudCommand(['auth', 'print-access-token']);
      expect(result.ok).toBe(false);
    });

    it('rejects auth print-identity-token', () => {
      const result = validateGcloudCommand(['auth', 'print-identity-token']);
      expect(result.ok).toBe(false);
    });
  });

  describe('dangerous flags', () => {
    it('rejects --impersonate-service-account', () => {
      const result = validateGcloudCommand([
        'run',
        'services',
        'list',
        '--impersonate-service-account=other@proj.iam.gserviceaccount.com',
      ]);
      expect(result.ok).toBe(false);
    });

    it('rejects --credential-file-override', () => {
      const result = validateGcloudCommand([
        'run',
        'services',
        'list',
        '--credential-file-override=/tmp/other.json',
      ]);
      expect(result.ok).toBe(false);
    });

    it('rejects --account override', () => {
      const result = validateGcloudCommand([
        'run',
        'services',
        'list',
        '--account=other@other.com',
      ]);
      expect(result.ok).toBe(false);
    });
  });

  describe('rejects commands with no safe verb', () => {
    it('rejects empty command', () => {
      expect(validateGcloudCommand([]).ok).toBe(false);
    });

    it('rejects a bare service group with no verb', () => {
      expect(validateGcloudCommand(['compute', 'instances']).ok).toBe(false);
    });

    it('rejects "gcloud" alone', () => {
      expect(validateGcloudCommand(['gcloud']).ok).toBe(false);
    });
  });

  describe('case handling', () => {
    it('treats verbs case-insensitively', () => {
      expect(validateGcloudCommand(['run', 'services', 'DELETE', 'x']).ok).toBe(
        false,
      );
      expect(validateGcloudCommand(['run', 'services', 'LIST']).ok).toBe(true);
    });
  });

  describe('does not false-positive on flag values', () => {
    it('allows a filter value that contains unsafe-sounding substrings', () => {
      const result = validateGcloudCommand([
        'compute',
        'instances',
        'list',
        '--filter=name:delete-me',
      ]);
      expect(result.ok).toBe(true);
    });
  });
});
