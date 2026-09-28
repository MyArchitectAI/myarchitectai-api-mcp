import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RequestError } from '../src/errors.js';
import { isPublicAddress, RemoteMediaService } from '../src/remote-media.js';

const imageReply = {
  status: 200,
  contentType: 'image/png',
  contentLength: 3,
  bytes: Buffer.from([1, 2, 3]),
  tooLarge: false,
};

describe('RemoteMediaService', () => {
  it('rejects private literal and mixed DNS answers before any request', async () => {
    let requests = 0;
    const media = new RemoteMediaService({
      timeoutMs: 100,
      maxBytes: 100,
      resolve: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      requestPinned: async () => {
        requests += 1;
        return imageReply;
      },
    });
    await assert.rejects(() => media.fetchForPreview('https://127.0.0.1/image.png'), RequestError);
    await assert.rejects(() => media.fetchForPreview('https://cdn.example/image.png'), RequestError);
    assert.equal(requests, 0);
  });

  it('pins one approved DNS answer for the request', async () => {
    let resolutions = 0;
    let selectedAddress = '';
    const media = new RemoteMediaService({
      timeoutMs: 100,
      maxBytes: 100,
      resolve: async () => {
        resolutions += 1;
        return [{ address: resolutions === 1 ? '8.8.8.8' : '10.0.0.1', family: 4 }];
      },
      requestPinned: async (_url, selected) => {
        selectedAddress = selected.address;
        return imageReply;
      },
    });
    const result = await media.fetchForPreview('https://cdn.example/image.png');
    assert.equal(result.tooLarge, false);
    assert.equal(resolutions, 1);
    assert.equal(selectedAddress, '8.8.8.8');
  });

  it('never follows a redirect to another host', async () => {
    let requests = 0;
    const media = new RemoteMediaService({
      timeoutMs: 100,
      maxBytes: 100,
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      requestPinned: async () => {
        requests += 1;
        return { ...imageReply, status: 302, contentType: null, bytes: Buffer.alloc(0) };
      },
    });
    await assert.rejects(() => media.fetchForPreview('https://cdn.example/image.png'), RequestError);
    assert.equal(requests, 1);
  });

  it('rejects a successful response without an image content type', async () => {
    const media = new RemoteMediaService({
      timeoutMs: 100,
      maxBytes: 100,
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      requestPinned: async () => ({ ...imageReply, contentType: null }),
    });
    await assert.rejects(() => media.fetchForPreview('https://cdn.example/image.png'), RequestError);
  });

  it('allows small data images but never reads or saves local files', async () => {
    const media = new RemoteMediaService({ timeoutMs: 100, maxBytes: 100 });
    const result = await media.fetchForPreview('data:image/png;base64,AQID');
    assert.equal(result.tooLarge, false);
    await assert.rejects(() => media.fetchForPreview('/etc/passwd'), RequestError);
    await assert.rejects(() => media.fetchForPreview('file:///etc/passwd'), RequestError);
    await assert.rejects(() => media.save('data:image/png;base64,AQID', { dir: '/tmp' }), RequestError);
  });

  it('requires public HTTPS on the standard port', async () => {
    const media = new RemoteMediaService({ timeoutMs: 100, maxBytes: 100 });
    await assert.rejects(() => media.check('http://8.8.8.8/image.png'), RequestError);
    await assert.rejects(() => media.check('https://8.8.8.8:8443/image.png'), RequestError);
    await assert.rejects(() => media.check('https://user:secret@8.8.8.8/image.png'), RequestError);
    await assert.rejects(() => media.check('https://service.local/image.png'), RequestError);
  });
});

describe('public IP classification', () => {
  it('blocks private, special-use, mapped and tunnel addresses', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.1.1',
      '100.64.1.1', '198.18.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2002:0a00:0001::']) {
      assert.equal(isPublicAddress(address), false, address);
    }
    assert.equal(isPublicAddress('8.8.8.8'), true);
    assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  });
});
