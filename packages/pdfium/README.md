# @familis/scribe-pdfium

PDFium adapter for `@familis/scribe`. It opens PDFs, extracts positioned native text, and renders
page bitmaps for OCR using the low-level `@embedpdf/pdfium` WebAssembly API.

## Installation

```sh
pnpm add @familis/scribe @familis/scribe-pdfium
```

Add an OCR adapter separately if scanned or hybrid documents must be processed.

## Usage with Scribe

```ts
import { createScribe } from "@familis/scribe";
import { createPdfiumEngine } from "@familis/scribe-pdfium";

const scribe = createScribe({
  pdf: await createPdfiumEngine(),
});

try {
  const result = await scribe.parse(bytes, profile, { ocr: "never" });
  console.log(result.data);
} finally {
  await scribe.close();
}
```

## Direct engine usage

The adapter implements the public `PdfEngine` contract and can also be used directly:

```ts
const engine = await createPdfiumEngine();

try {
  const document = await engine.open(pdfBytes);

  try {
    const page = await document.getPage(0);
    const tokens = await page.extractText();
    const bitmap = await page.render({
      dpi: 300,
      grayscale: true,
    });

    console.log(tokens, bitmap.width, bitmap.height, bitmap.dpi);
  } finally {
    await document.close();
  }
} finally {
  await engine.close();
}
```

Pages use zero-based indexes in `getPage`. Their public `number` property is one-based.

## Native text extraction

PDFium character boxes are normalized to coordinates between `0` and `1` with a top-left origin.
Characters are grouped into words and lines using whitespace, position, and spacing heuristics.

Each extracted token contains:

```ts
interface TextToken {
  text: string;
  box: { x: number; y: number; width: number; height: number };
  source: "native";
  lineIndex?: number;
}
```

This package does not reconstruct tables on its own. Profiles use token coordinates, anchors,
regex captures and `field.table` to extract structured values.

## Rules

`page.rules()` lists the straight lines drawn on the page, which `field.table` uses as column
boundaries:

```ts
const { vertical, horizontal } = await page.rules();
// vertical: [{ position: 0.12, start: 0.3, end: 0.8 }, …] (x, then top and bottom)
```

- Every straight, axis-aligned segment of a stroked path is a rule, so lines, stroked rectangles
  and grids drawn as one path all contribute their sides.
- A filled path is a rule when its bounds are a thin, long box, at most 3 points thick. Wider
  filled shapes, such as cell shading, are ignored.
- Segments shorter than 6 points are ignored, and so are paths nested in form XObjects.

Text rendered as an image is not returned by native extraction. Configure an OCR adapter for those
regions or pages.

## Rendering

`page.render` accepts a DPI and returns either:

- `gray8`: one grayscale byte per pixel;
- `rgba8`: four bytes per pixel.

The resulting bitmap records the requested DPI so OCR adapters can preserve the correct image
density.

Pass `clip` to render a normalized area only. The bitmap is allocated for that area, widened to
whole pixels of the full-page render, and `box` reports the page area it covers:

```ts
const band = await page.render({
  dpi: 96,
  grayscale: true,
  clip: { x: 0.04, y: 0.22, width: 0.92, height: 0.16 },
});
// band.box: the exact normalized area rendered
```

The core package renders OCR regions this way, at their `renderDpi`, and whole pages in grayscale at
300 DPI. It checks the configured pixel limit before allocating the bitmap.

## Embedded images

`page.images()` returns the raster images placed upright on the page, with their native pixels:

```ts
for (const image of await page.images()) {
  image.box; // normalized placement
  image.bitmap; // gray8 pixels as stored in the PDF, dpi = pixels per inch of the placement
}
```

Core OCRs these pixels directly when an OCR region overlaps them, which reads better than a render
that resamples them. Rotated, skewed and flipped images, and images nested in form XObjects, are not
returned, so their regions fall back to a clipped render. Image masks are not applied.

## Passwords and errors

```ts
const document = await engine.open(bytes, {
  password: "secret",
  signal,
});
```

- Missing or invalid passwords produce `EncryptedPdfError`.
- Malformed or unsupported documents produce `InvalidPdfError`.
- Other PDFium failures produce `PdfEngineError`.
- Aborted operations produce `AbortError`.

## WebAssembly and deployment

The PDFium WASM binary is supplied by `@embedpdf/pdfium` and resolved from `node_modules`. This
adapter does not fetch it from a CDN.

Install production dependencies inside the target Linux or container environment. Do not copy
`node_modules` from another operating system. When creating deployment bundles, preserve the
`@embedpdf/pdfium` package and its `pdfium.wasm` asset.

The monorepo publication check installs the packed adapter in an isolated consumer project and
verifies that the WASM asset can be resolved.

## Advanced module configuration

Emscripten module overrides can be passed when a custom environment requires them:

```ts
const engine = await createPdfiumEngine({
  moduleOverrides: {
    // @embedpdf/pdfium module options
  },
});
```

Most Node.js and Bun applications should use the defaults.

## Resource lifecycle

Documents and engines expose idempotent `close()` methods. Always close a directly managed document
and engine. When composed through `createScribe`, the document is closed after every parse and
`scribe.close()` closes the engine.

All WASM allocations used for document bytes, character boxes, pages, text pages, and bitmaps are
released through guarded cleanup paths.

## Runtime support

- Node.js 22.12 or newer.
- Current stable Bun.
- Server runtimes only; browser and edge use are not supported in v1.

## License

MIT
