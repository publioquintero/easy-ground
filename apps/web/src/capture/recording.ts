import { createWorker, OEM, type Worker } from 'tesseract.js';
import { parseStopCardFrames, type StopCard } from '@easy-ground/core';

/**
 * Source 3: a screen recording of GroundCloud while the driver swipes through the stop
 * cards. Frames are taken from the video in the browser, frames that look the same as the
 * last one read are skipped, and the rest are OCR'd. The video never leaves the phone.
 */

/** Seconds between sampled frames; longer videos sample more sparsely (see MAX_FRAMES). */
const STEP_S = 0.75;
const MAX_FRAMES = 400;
/** Frames are read at this width at most (an iPhone recording is ~1170–1290 px wide). */
const MAX_WIDTH = 1600;
/** Mean gray difference (0–255) on a tiny thumbnail below which a frame is "the same". */
const SAME_FRAME = 4;

let workerPromise: Promise<Worker> | null = null;
function getWorker(): Promise<Worker> {
  workerPromise ??= createWorker('eng', OEM.LSTM_ONLY); // PSM 3: free-form screen text
  return workerPromise;
}

function once(target: HTMLMediaElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = () => {
      target.removeEventListener('error', fail);
      resolve();
    };
    const fail = () => {
      target.removeEventListener(event, ok);
      reject(new Error('This video could not be read. Try a screen recording saved from Photos.'));
    };
    target.addEventListener(event, ok, { once: true });
    target.addEventListener('error', fail, { once: true });
  });
}

function thumbnail(ctx: CanvasRenderingContext2D, video: HTMLVideoElement): Uint8ClampedArray {
  ctx.drawImage(video, 0, 0, 24, 24);
  const rgba = ctx.getImageData(0, 0, 24, 24).data;
  const gray = new Uint8ClampedArray(24 * 24);
  for (let i = 0; i < gray.length; i++) gray[i] = (rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]) / 3;
  return gray;
}

const difference = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
};

export async function readStopCardRecording(
  file: File,
  onProgress?: (message: string) => void,
): Promise<StopCard[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    onProgress?.('Opening the recording…');
    await once(video, 'loadeddata');
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration <= 0) throw new Error('This video has no length.');
    const step = Math.max(STEP_S, duration / MAX_FRAMES);

    const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
    const frame = document.createElement('canvas');
    frame.width = Math.round(video.videoWidth * scale);
    frame.height = Math.round(video.videoHeight * scale);
    const frameCtx = frame.getContext('2d')!;
    const thumb = document.createElement('canvas');
    thumb.width = thumb.height = 24;
    const thumbCtx = thumb.getContext('2d', { willReadFrequently: true })!;

    onProgress?.('Loading text recognition…');
    const worker = await getWorker();
    const texts: string[] = [];
    let last: Uint8ClampedArray | null = null;
    const total = Math.floor(duration / step) + 1;
    for (let k = 0; k < total; k++) {
      // Listen before seeking; never seek to the current time (0 at start), which fires nothing.
      const seeked = once(video, 'seeked');
      video.currentTime = Math.max(0.01, Math.min(duration - 0.05, k * step));
      await seeked;
      const t = thumbnail(thumbCtx, video);
      if (last && difference(last, t) < SAME_FRAME) continue;
      last = t;
      frameCtx.drawImage(video, 0, 0, frame.width, frame.height);
      const { data } = await worker.recognize(frame);
      texts.push(data.text);
      onProgress?.(`Reading the recording… ${Math.round(((k + 1) / total) * 100)}% · ${parseStopCardFrames(texts).length} stops`);
    }
    return parseStopCardFrames(texts);
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
