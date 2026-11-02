import type { ReactElement } from 'react';

const MAX_GIF_FRAMES = 60;
const GIF_MAX_WIDTH = 960;

/** Standalone SVG files cannot see the page's CSS, so its theme colors are written in. */
export function inlineCssVariables(markup: string, source: CSSStyleDeclaration): string {
  return markup.replace(/var\((--[\w-]+)\)/g, (original, name: string) => {
    const value = source.getPropertyValue(name).trim();
    return value ? value.replace(/"/g, "'") : original;
  });
}

async function toMarkup(frame: ReactElement): Promise<string> {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const style = getComputedStyle(document.documentElement);
  return inlineCssVariables(renderToStaticMarkup(frame), style);
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function loadImage(markup: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('This frame could not be turned into an image.'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  });
}

function drawFrame(
  image: HTMLImageElement,
  width: number,
  height: number,
): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser could not create an image.');
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--surface');
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return context;
}

export async function exportSvg(frame: ReactElement, name: string): Promise<void> {
  const markup = await toMarkup(frame);
  download(new Blob([markup], { type: 'image/svg+xml' }), `${name}.svg`);
}

export async function exportPng(frame: ReactElement, name: string): Promise<void> {
  const image = await loadImage(await toMarkup(frame));
  const { canvas } = drawFrame(image, image.naturalWidth * 2, image.naturalHeight * 2);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('This frame could not be turned into an image.');
  download(blob, `${name}.png`);
}

/** Picks evenly spaced steps, always keeping the first and last. */
export function sampleFrameIndexes(total: number, limit = MAX_GIF_FRAMES): number[] {
  if (total <= limit) return Array.from({ length: total }, (_, i) => i);
  return Array.from({ length: limit }, (_, i) => Math.round((i * (total - 1)) / (limit - 1)));
}

export async function exportGif(
  frameAt: (index: number) => ReactElement,
  total: number,
  name: string,
  onProgress: (fraction: number) => void,
): Promise<void> {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
  const indexes = sampleFrameIndexes(total);
  const gif = GIFEncoder();
  let width = 0;
  let height = 0;
  for (const [position, index] of indexes.entries()) {
    const image = await loadImage(await toMarkup(frameAt(index)));
    if (position === 0) {
      const scale = Math.min(1, GIF_MAX_WIDTH / image.naturalWidth);
      width = Math.round(image.naturalWidth * scale);
      height = Math.round(image.naturalHeight * scale);
    }
    const { data } = drawFrame(image, width, height).getImageData(0, 0, width, height);
    const palette = quantize(data, 256);
    const isLast = position === indexes.length - 1;
    gif.writeFrame(applyPalette(data, palette), width, height, {
      palette,
      delay: isLast ? 2500 : 1200,
    });
    onProgress((position + 1) / indexes.length);
    // Gives the page a chance to paint, so the progress shows and the tab stays responsive.
    await new Promise((resolve) => setTimeout(resolve));
  }
  gif.finish();
  download(new Blob([gif.bytes()], { type: 'image/gif' }), `${name}.gif`);
}
