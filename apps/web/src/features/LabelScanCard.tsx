import { useState, type ChangeEvent } from 'react';
import { matchLabelToStops, stopFromLabel, type LabelAddress, type LabelMatch, type StopDraft } from '@easy-ground/core';
import { useAppDispatch, useAppSelector } from '../store';
import { useGeocodeMutation } from '../store/api';
import { currentStopSet, labelScannedAtStop, nextFreeStopNumber, stopAdded, stopsLocated } from '../store/routeSlice';
import { StopEditor } from './StopEditor';

type Scan =
  | { kind: 'matched'; label: LabelAddress; match: Exclude<LabelMatch, { kind: 'none' }> }
  | { kind: 'new'; label: LabelAddress | null; draft: StopDraft }
  | { kind: 'added'; stopNumber: number; message: string };

/**
 * A box on the truck that isn't on the manifest: photograph its FedEx label, and the app
 * either finds the stop it belongs to or creates a new one ("From label") and puts it on the map.
 */
export function LabelScanCard() {
  const dispatch = useAppDispatch();
  const { drafts, area } = useAppSelector((s) => s.route);
  const [geocode] = useGeocodeMutation();
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState<Scan | null>(null);
  const busy = progress !== null;

  if (drafts.length === 0) return null;

  async function onPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    setScan(null);
    try {
      setProgress('Loading label reader…');
      const { readLabelPhoto } = await import('../capture/label');
      const { label, trackingNumber } = await readLabelPhoto(file, setProgress);
      if (!label) {
        setError(
          trackingNumber
            ? `Read tracking # ${trackingNumber} but not the address. Retake the photo closer, without glare, or type the address.`
            : 'Could not read this label. Retake the photo closer and without glare, or type the address.',
        );
        return;
      }
      const match = matchLabelToStops(label, drafts);
      setScan(
        match.kind === 'none'
          ? { kind: 'new', label, draft: stopFromLabel(label, nextFreeStopNumber(drafts)) }
          : { kind: 'matched', label, match },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the photo');
    } finally {
      setProgress(null);
    }
  }

  function typeByHand() {
    const draft: StopDraft = {
      ...stopFromLabel(
        { customerName: null, street: '', addressLine2: null, city: null, state: null, zip: null, trackingNumber: null, source: 'ocr' },
        nextFreeStopNumber(drafts),
      ),
    };
    setError(null);
    setScan({ kind: 'new', label: null, draft });
  }

  async function addNewStop(draft: StopDraft) {
    dispatch(stopAdded(draft));
    setScan({ kind: 'added', stopNumber: draft.stopNumber, message: `Added as stop ${draft.stopNumber}. Locating it on the map…` });
    const zip = draft.zip ?? undefined;
    const where = area ?? (zip ? { zip } : null);
    if (!where) {
      setScan({ kind: 'added', stopNumber: draft.stopNumber, message: `Added as stop ${draft.stopNumber}. Set the route area to put it on the map.` });
      return;
    }
    const response = await geocode({ area: where, addresses: [{ id: String(draft.stopNumber), address: draft.addressRaw, ...(zip ? { zip } : {}) }] });
    const result = 'data' in response ? response.data?.results[0] : undefined;
    if (result) dispatch(stopsLocated([result]));
    setScan({
      kind: 'added',
      stopNumber: draft.stopNumber,
      message:
        result?.status === 'ok'
          ? `Added as stop ${draft.stopNumber} and placed on the map.`
          : result?.status === 'review'
            ? `Added as stop ${draft.stopNumber}. Check its map match in Review.`
            : `Added as stop ${draft.stopNumber}, but it wasn't found on the map. Check the address in Review.`,
    });
  }

  function atStop(stopNumber: number, extraPackage: boolean, label: LabelAddress) {
    dispatch(labelScannedAtStop({ stopNumber, trackingNumber: label.trackingNumber, extraPackage }));
    dispatch(currentStopSet(stopNumber));
    setScan(null);
  }

  return (
    <section className="card">
      <h2>Box not on the manifest?</h2>
      <p className="muted small">Take a photo of the FedEx label. The address is read on this phone from the barcode or the printed text.</p>
      <div className="row">
        <label className={`button primary${busy ? ' disabled' : ''}`}>
          {progress ?? 'Scan package label'}
          <input type="file" accept="image/*" hidden disabled={busy} onChange={onPhoto} />
        </label>
      </div>

      {error && (
        <div className="general-issue" style={{ marginTop: 12 }}>
          <p className="small bad">{error}</p>
          <div className="row tight">
            <button className="button small-btn" onClick={typeByHand}>Type address</button>
          </div>
        </div>
      )}

      {scan?.kind === 'matched' && (
        <div className="label-result">
          <p className="small">
            {scan.match.kind === 'tracking' ? 'Already scanned. This box goes to ' : 'This box goes to '}
            <strong className="text">stop {scan.match.stop.stopNumber}</strong>
            {scan.match.stop.shelfId && <> · SID <strong className="text">{scan.match.stop.shelfId}</strong></>}
            {' · '}{scan.match.stop.packageCount} pkg{scan.match.stop.packageCount === 1 ? '' : 's'}
          </p>
          <p className="small muted">{scan.match.stop.addressRaw}{scan.match.stop.addressLine2 && ` · ${scan.match.stop.addressLine2}`}</p>
          <p className="small muted">Label: {scan.label.street}{scan.label.addressLine2 && ` · ${scan.label.addressLine2}`}, {scan.label.city} {scan.label.state} {scan.label.zip}</p>
          <div className="row">
            <button className="button primary" onClick={() => atStop(scan.match.stop.stopNumber, false, scan.label)}>Go to stop</button>
            {scan.match.kind === 'address' && (
              <button className="button" onClick={() => atStop(scan.match.stop.stopNumber, true, scan.label)}>+1 package (extra box)</button>
            )}
            <button
              className="button ghost"
              onClick={() => setScan({ kind: 'new', label: scan.label, draft: stopFromLabel(scan.label, nextFreeStopNumber(drafts)) })}
            >
              Different stop
            </button>
          </div>
        </div>
      )}

      {scan?.kind === 'new' && (
        <div className="new-stop">
          <h3>New stop from label</h3>
          {scan.label && (
            <p className="small muted" style={{ margin: '0 12px' }}>
              Read from the {scan.label.source === 'barcode' ? 'barcode' : 'printed text'}
              {scan.label.city && ` · ${scan.label.city} ${scan.label.state ?? ''} ${scan.label.zip ?? ''}`}
              {scan.label.trackingNumber && ` · TRK ${scan.label.trackingNumber}`}. Check it before adding.
            </p>
          )}
          <StopEditor
            stop={scan.draft}
            isNew
            takenNumbers={drafts.map((d) => d.stopNumber)}
            onCancel={() => setScan(null)}
            // The editor only edits manifest fields; keep the label's city/ZIP/tracking.
            onSave={(edited) => void addNewStop({ ...scan.draft, ...edited, source: 'label' })}
          />
        </div>
      )}

      {scan?.kind === 'added' && (
        <p className="small good" style={{ marginTop: 12 }}>
          {scan.message}{' '}
          <button className="link" onClick={() => { dispatch(currentStopSet(scan.stopNumber)); setScan(null); }}>Go to it</button>
        </p>
      )}
    </section>
  );
}
