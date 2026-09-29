import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPortalAccountResolver, type PortalAccountOptions } from '../src/portal-account.js';

const issuer = 'https://portal-project.supabase.co/auth/v1';
const subjectA = '00000000-0000-0000-0000-000000000001';
const subjectB = '00000000-0000-0000-0000-000000000002';
const options = (): PortalAccountOptions => ({
  issuer,
  supabaseUrl: 'https://portal-project.supabase.co',
  serviceRoleKey: 'synthetic-service-key',
  keyBindings: new Map([[subjectA, 101], [subjectB, 202]]),
  awsRegion: 'eu-central-1',
  awsAccessKeyId: 'SYNTHETICACCESSKEY',
  awsSecretAccessKey: 'synthetic-secret-access-key',
  awsSessionToken: 'synthetic-session-token',
});
const identity = (subject: string, verifiedIssuer = issuer) => ({ issuer: verifiedIssuer, subject, clientId: 'trusted-client' });
const signal = (): AbortSignal => new AbortController().signal;
const json = (body: unknown): Response => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});

describe('portal account resolver', () => {
  it('does no I/O for another issuer or an unbound subject', async () => {
    const noNetwork: typeof fetch = () => { throw new Error('network must not run'); };
    const resolve = createPortalAccountResolver(options(), { portalFetch: noNetwork, awsFetch: noNetwork });
    assert.equal(await resolve(identity(subjectA, 'https://app.example/auth/v1'), { signal: signal() }), undefined);
    assert.equal(await resolve(identity('00000000-0000-0000-0000-000000000003'), { signal: signal() }), undefined);
    assert.throws(() => createPortalAccountResolver({ ...options(), issuer: 'https://app.example/auth/v1' }));
  });

  it('rejects ambiguous clients and keys outside the selected client', async () => {
    let keyQueries = 0;
    let awsQueries = 0;
    const ambiguous: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/clients')) {
        return json([{ id: 11, user_id: subjectA }, { id: 12, user_id: subjectA }]);
      }
      keyQueries++;
      return json([]);
    };
    const awsFetch: typeof fetch = async () => { awsQueries++; return json({}); };
    const first = createPortalAccountResolver(options(), { portalFetch: ambiguous, awsFetch });
    assert.equal(await first(identity(subjectA), { signal: signal() }), undefined);
    assert.equal(keyQueries, 0);
    const wrongOwner: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      return path.endsWith('/clients') ? json([{ id: 11, user_id: subjectA }])
        : json([{ id: 101, client_id: 12, aws_key_id: 'aws-101', deleted_at: null }]);
    };
    const second = createPortalAccountResolver(options(), { portalFetch: wrongOwner, awsFetch });
    assert.equal(await second(identity(subjectA), { signal: signal() }), undefined);
    const deleted: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      return path.endsWith('/clients') ? json([{ id: 11, user_id: subjectA }])
        : json([{ id: 101, client_id: 11, aws_key_id: 'aws-101', deleted_at: '2026-09-29T00:00:00Z' }]);
    };
    const third = createPortalAccountResolver(options(), { portalFetch: deleted, awsFetch });
    assert.equal(await third(identity(subjectA), { signal: signal() }), undefined);
    assert.equal(awsQueries, 0);
  });

  it('rejects disabled, mismatched or empty AWS API keys', async () => {
    const portalFetch: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      return path.endsWith('/clients') ? json([{ id: 11, user_id: subjectA }])
        : json([{ id: 101, client_id: 11, aws_key_id: 'aws-101', deleted_at: null }]);
    };
    for (const awsResult of [
      { id: 'aws-101', enabled: false, value: 'synthetic-value' },
      { id: 'another-key', enabled: true, value: 'synthetic-value' },
      { id: 'aws-101', enabled: true, value: '' },
      { id: 'aws-101', enabled: true },
    ]) {
      const resolve = createPortalAccountResolver(options(), {
        portalFetch, awsFetch: async () => json(awsResult),
      });
      assert.equal(await resolve(identity(subjectA), { signal: signal() }), undefined);
    }
  });

  it('checks every identity and selected key on each request, then returns isolated API credentials', async () => {
    const portalCalls: URL[] = [];
    const awsCalls: Array<{ url: URL; headers: Record<string, string>; redirect: string | undefined }> = [];
    const portalFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      portalCalls.push(url);
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'error');
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.apikey, 'synthetic-service-key');
      if (url.pathname.endsWith('/clients')) {
        const subject = url.searchParams.get('user_id');
        return json(subject === `eq.${subjectA}` ? [{ id: 11, user_id: subjectA }] : [{ id: 22, user_id: subjectB }]);
      }
      assert.equal(url.searchParams.get('deleted_at'), 'is.null');
      const selected = url.searchParams.get('id');
      return json(selected === 'eq.101'
        ? [{ id: 101, client_id: 11, aws_key_id: 'aws-101', deleted_at: null }]
        : [{ id: 202, client_id: 22, aws_key_id: 'aws-202', deleted_at: null }]);
    };
    const awsFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = init?.headers as Record<string, string>;
      awsCalls.push({ url, headers, redirect: init?.redirect });
      assert.equal(url.host, 'apigateway.eu-central-1.amazonaws.com');
      assert.equal(url.searchParams.get('includeValue'), 'true');
      const id = url.pathname.split('/').at(-1);
      // Independently generated with @smithy/signature-v4 5.7.4 for these fixed synthetic inputs.
      const signature = id === 'aws-101'
        ? '5a4dae843e7ffc125e8fc5a9be25c3cfe049d624af767ce5a66624c46cbeb2a9'
        : '12896d44b74d80adc0ed200c22f7a3effca410652556370d9c0650464dee6bf8';
      assert.equal(headers.authorization, `AWS4-HMAC-SHA256 Credential=SYNTHETICACCESSKEY/20260929/eu-central-1/apigateway/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=${signature}`);
      assert.equal(headers['x-amz-security-token'], 'synthetic-session-token');
      assert.equal(init?.redirect, 'error');
      return json({ id: id ?? '', enabled: true, value: id === 'aws-101' ? 'secret-for-a' : 'secret-for-b' });
    };
    const resolve = createPortalAccountResolver(options(), { portalFetch, awsFetch,
      now: () => new Date('2026-09-29T12:34:56Z') });
    const first = await resolve(identity(subjectA), { signal: signal() });
    const second = await resolve(identity(subjectB), { signal: signal() });
    assert.equal(first?.apiKey, 'secret-for-a');
    assert.equal(second?.apiKey, 'secret-for-b');
    assert.equal(first?.baseUrl, 'https://api.myarchitectai.com/v1');
    assert.equal(first?.timeoutMs, 120_000);
    assert.equal(first?.maxRetries, 2);
    assert.equal(first?.maxPreviewBytes, 1_000_000);
    assert.equal(first?.stateFile, undefined);
    assert.equal(portalCalls.length, 4);
    assert.equal(awsCalls.length, 2);
    assert.ok(!JSON.stringify(portalCalls).includes('secret-for-a'));
    assert.ok(!JSON.stringify(awsCalls).includes('secret-for-b'));
  });

  it('bounds portal responses and stops on cancellation before AWS lookup', async () => {
    let awsCalls = 0;
    const awsFetch: typeof fetch = async () => { awsCalls++; return json({}); };
    const oversized = createPortalAccountResolver(options(), {
      portalFetch: async () => json([{ id: 11, user_id: subjectA, extra: 'x'.repeat(10_000) }]), awsFetch,
    });
    await assert.rejects(Promise.resolve(oversized(identity(subjectA), { signal: signal() })));
    const controller = new AbortController();
    let portalSignal: AbortSignal | undefined;
    const pending = createPortalAccountResolver(options(), {
      portalFetch: async (_input, init) => {
        portalSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }, awsFetch,
    });
    const work = pending(identity(subjectA), { signal: controller.signal });
    controller.abort();
    await assert.rejects(Promise.resolve(work));
    assert.equal(portalSignal?.aborted, true);
    assert.equal(awsCalls, 0);
    let finishLateFetch: (() => void) | undefined;
    const lateGate = new Promise<void>((resolve) => { finishLateFetch = resolve; });
    let latePortalCalls = 0;
    const ignoresAbort = createPortalAccountResolver(options(), {
      portalFetch: async () => {
        latePortalCalls++;
        await lateGate;
        return json([{ id: 11, user_id: subjectA }]);
      }, awsFetch,
    });
    const lateController = new AbortController();
    const lateWork = ignoresAbort(identity(subjectA), { signal: lateController.signal });
    lateController.abort();
    await assert.rejects(Promise.resolve(lateWork));
    finishLateFetch?.();
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(latePortalCalls, 1);
    assert.equal(awsCalls, 0);
  });

  it('uses one deadline across both portal reads and the AWS read', async () => {
    let portalCalls = 0;
    let awsCalls = 0;
    const portalFetch: typeof fetch = async (input, init) => {
      portalCalls++;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 130);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        }, { once: true });
      });
      return new URL(String(input)).pathname.endsWith('/clients')
        ? json([{ id: 11, user_id: subjectA }])
        : json([{ id: 101, client_id: 11, aws_key_id: 'aws-101', deleted_at: null }]);
    };
    const resolve = createPortalAccountResolver(options(), {
      portalFetch, awsFetch: async () => { awsCalls++; return json({}); }, lookupTimeoutMs: 200,
    });
    await assert.rejects(Promise.resolve(resolve(identity(subjectA), { signal: signal() })));
    assert.equal(portalCalls, 2);
    assert.equal(awsCalls, 0);
  });
});
