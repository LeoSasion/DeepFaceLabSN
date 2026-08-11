# Fictional demo identities

The SRC and DST portraits in this directory are fully synthetic adults generated for the DeepFaceLabSN product demo. They are not photographs of real people and are not intended to resemble any identifiable person.

## SRC prompt

Use case: photorealistic-natural. Asset type: a source-identity portrait for a face-swap application demo. Create one fully synthetic, fictional adult woman in her early 30s with East Asian features, shoulder-length dark hair, calm confident expression, front-facing head-and-shoulders crop, direct gaze, eye-level camera, neutral deep charcoal studio background, soft even studio lighting, natural skin texture and pores, 85mm portrait-lens look, realistic color, sharp eyes, consistent unobstructed facial landmarks, no jewelry covering the face. The person must not resemble any real public figure or identifiable individual. No text, no logo, no watermark, no border. Square composition, face centered with comfortable crop margin.

## DST prompt

Use case: photorealistic-natural. Asset type: a destination-identity portrait for a face-swap application demo. Create one fully synthetic, fictional adult man in his early 40s with Mediterranean features, short salt-and-pepper hair, subtle trimmed stubble, neutral attentive expression, front-facing head-and-shoulders crop, direct gaze, eye-level camera, neutral slate-gray studio background, soft even studio lighting, natural skin texture and pores, 85mm portrait-lens look, realistic color, sharp eyes, consistent unobstructed facial landmarks, no glasses and no accessories covering the face. The person must not resemble any real public figure or identifiable individual. No text, no logo, no watermark, no border. Square composition, face centered with comfortable crop margin.

The live workspace uses derived JPEG copies that retain the existing DFL aligned container metadata. The original PNGs here are the durable source assets; no MP4 extraction step is required.

## Training-preview prompt

The contact sheet in `training-preview-demo.png` was generated from both portraits with this prompt:

Use case: photorealistic-natural. Create a clean DeepFaceLab training-preview contact sheet using only the two supplied fully synthetic fictional identities. Wide 5:2 canvas, exactly two rows and five equal square cells per row, edge-to-edge cells with no gutters and no text. Each row follows this visual sequence: source identity portrait, softly blurred reconstruction of source, destination identity portrait, softly blurred reconstruction of destination, softly blurred face-swap result combining the source identity onto the destination framing. Repeat the same consistent two identities in row two with subtle expression variation. Preserve the supplied facial identity, dark neutral backdrops, frontal crops, even lighting. The blur should resemble an early neural-network training preview, not motion blur. No captions, no labels, no logos, no watermark, no border.

This contact sheet is presentation-only demo imagery. It is intentionally not represented as an output produced by the bundled model weights.
