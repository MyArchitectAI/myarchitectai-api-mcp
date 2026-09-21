import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  changeTexturesSchema,
  setAtmosphereSchema,
  upscaleSchema,
  renderExteriorShape,
  renderInteriorShape,
  styleTransferShape,
  upscale4kShape,
} from '../src/schemas.js';

// 1x1 transparent PNG as a data: URI — the base64 input shape the descriptions
// now advertise. We assert the input schemas actually accept it, so the docs
// can't drift from the validator.
const PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('image input schemas accept HTTPS URLs and base64 data: URIs', () => {
  const imageFields = [
    ['render_exterior.image', renderExteriorShape.image],
    ['render_interior.image', renderInteriorShape.image],
    ['style_transfer.image', styleTransferShape.image],
    ['style_transfer.referenceImage', styleTransferShape.referenceImage],
    ['upscale_4k.image', upscale4kShape.image],
  ] as const;

  for (const [name, schema] of imageFields) {
    it(`${name} accepts a public HTTPS URL`, () => {
      assert.equal(schema.safeParse('https://cdn.example.com/in.png').success, true);
    });

    it(`${name} accepts an inline base64 data: URI`, () => {
      assert.equal(schema.safeParse(PNG_DATA_URI).success, true);
    });

    it(`${name} rejects a non-URL string`, () => {
      assert.equal(schema.safeParse('not a url').success, false);
    });
  }
});


describe('current input contract', () => {
  it('allows prompts beyond the removed 2000-character cap', () => {
    assert.equal(renderExteriorShape.prompt.safeParse('x'.repeat(3000)).success, true);
  });
  it('accepts reference texture mode and base64 masks', () => {
    assert.equal(changeTexturesSchema.safeParse({ image: PNG_DATA_URI, mask: PNG_DATA_URI, referenceImage: PNG_DATA_URI }).success, true);
  });
  it('accepts interior lighting and individual exterior controls', () => {
    assert.equal(setAtmosphereSchema.safeParse({ image: PNG_DATA_URI, sceneType: 'interior', lighting: 'warm_lamps' }).success, true);
    for (const extra of [{ timeOfDay: 'golden_hour' }, { season: 'autumn' }, { weather: 'fog' }]) {
      assert.equal(setAtmosphereSchema.safeParse({ image: PNG_DATA_URI, sceneType: 'exterior', ...extra }).success, true);
    }
  });
  it('accepts PNG at 4K and upstream defaults without injecting optional fields', () => {
    assert.equal(upscaleSchema.safeParse({ image: PNG_DATA_URI, targetResolution: '4k', outputFormat: 'png' }).success, true);
    assert.deepEqual(upscaleSchema.parse({ image: PNG_DATA_URI }), { image: PNG_DATA_URI });
  });
});
