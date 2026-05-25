import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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
