import { useState, type ChangeEvent } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { areaSet, manifestImported, routeCleared } from '../store/routeSlice';
import { DEMO_AREA, DEMO_ROUTE } from '../demo/demoRoute';
import { mergeStopCards } from '@easy-ground/core';
import { store } from '../store';

const isPdf = (f: File) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
const isVideo = (f: File) => f.type.startsWith('video/') || /\.(mov|mp4|m4v)$/i.test(f.name);

export function ImportPanel() {
  const dispatch = useAppDispatch();
  const stopCount = useAppSelector((s) => s.route.drafts.length);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const busy = progress !== null;

  async function onFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (files.length === 0) return;
    setError(null);
    setNote(null);
    try {
      const pdfs = files.filter(isPdf);
      const videos = files.filter(isVideo);
      const images = files.filter((f) => !isPdf(f) && !isVideo(f));

      if (pdfs.length > 0) {
        setProgress('Reading PDF…');
        // pdf.js and the OCR engine are heavy: load them only when needed.
        const { parseManifestPdf } = await import('../capture/pdf');
        for (const file of pdfs) {
          dispatch(manifestImported({ ...(await parseManifestPdf(file)), sourceName: file.name }));
        }
      }
      if (images.length > 0) {
        setProgress('Loading text recognition…');
        const { parseManifestImages } = await import('../capture/ocr');
        const result = await parseManifestImages(images, (done, total) =>
          setProgress(done < total ? `Reading screenshot ${done + 1} of ${total}…` : 'Done'),
        );
        const sourceName = images.length === 1 ? images[0].name : `${images.length} screenshots`;
        dispatch(manifestImported({ ...result, sourceName }));
      }
      for (const file of videos) {
        // Stop cards don't show the manifest's "#": they are matched to the route by address.
        const { readStopCardRecording } = await import('../capture/recording');
        const cards = await readStopCardRecording(file, setProgress);
        if (cards.length === 0) {
          setError('No GroundCloud stop cards found in the recording.');
          continue;
        }
        const merged = mergeStopCards(cards, store.getState().route.drafts);
        dispatch(manifestImported({ stops: merged.stops, issues: merged.issues, sourceName: file.name }));
        setNote(
          `Recording: ${cards.length} stop cards — ${merged.matched} matched to the route` +
            (merged.added ? `, ${merged.added} new (check their numbers).` : '.'),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the file');
    } finally {
      setProgress(null);
    }
  }

  return (
    <section className="card">
      <h2>Import manifest</h2>
      <p className="muted small">
        Manifest View PDF (🖨️ → Save to Files) or screenshots of Manifest View. Overlapping screenshots are fine. A screen
        recording swiping through the stop cards adds full addresses, ZIPs and customer notes.
      </p>
      <div className="row">
        <label className={`button primary${busy ? ' disabled' : ''}`}>
          {progress ?? 'Choose PDF, screenshots or recording'}
          <input type="file" accept="application/pdf,image/*,video/*" multiple hidden disabled={busy} onChange={onFiles} />
        </label>
        {stopCount === 0 && !busy && (
          <button
            className="button ghost"
            onClick={() => {
              dispatch(areaSet(DEMO_AREA));
              dispatch(manifestImported({ ...DEMO_ROUTE, sourceName: 'Demo route · Washington, DC' }));
            }}
          >
            Try a demo route
          </button>
        )}
        {stopCount > 0 && !busy && (
          <button className="button ghost" onClick={() => dispatch(routeCleared())}>
            Clear route
          </button>
        )}
      </div>
      {note && <p className="muted small">{note}</p>}
      {error && <p className="bad small">{error}</p>}
    </section>
  );
}
