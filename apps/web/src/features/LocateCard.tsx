import { useState, type FormEvent } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { useGeocodeMutation, type RouteArea } from '../store/api';
import { areaSet, stopsLocated } from '../store/routeSlice';

const describeArea = (a: RouteArea) => a.zip ?? `${a.city}, ${a.state}`;

/** Route area (the manifest has no city/ZIP) + geocoding of the stops that still need it. */
export function LocateCard() {
  const dispatch = useAppDispatch();
  const { drafts, area, geo } = useAppSelector((s) => s.route);
  const [geocode, { isLoading, error }] = useGeocodeMutation();
  const [changingArea, setChangingArea] = useState(false);
  const [form, setForm] = useState({ zip: area?.zip ?? '', city: area?.city ?? '', state: area?.state ?? '' });

  if (drafts.length === 0) return null;

  const pending = drafts.filter((d) => !d.completed && d.addressRaw);
  // The printed manifest (and package labels) give each stop its own ZIP: then no route
  // area is needed, and the most common ZIP stands in for it in the request.
  const zips = [...new Set(pending.map((d) => d.zip).filter((z): z is string => !!z && /^\d{5}$/.test(z)))];
  const ownZips = pending.length > 0 && pending.every((d) => d.zip && /^\d{5}$/.test(d.zip));
  const commonZip = zips
    .map((z) => [z, pending.filter((d) => d.zip === z).length] as const)
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  const effectiveArea: RouteArea | null = area ?? (ownZips && commonZip ? { zip: commonZip } : null);
  const editingArea = !effectiveArea || changingArea;
  const toLocate = pending.filter((d) => !geo[d.stopNumber] || geo[d.stopNumber].status === 'error');
  const counts = pending.reduce(
    (acc, d) => {
      const status = geo[d.stopNumber]?.status;
      if (status) acc[status] += 1;
      return acc;
    },
    { ok: 0, review: 0, not_found: 0, error: 0 },
  );
  const provider = Object.values(geo)[0]?.provider;

  const zip = form.zip.trim();
  const city = form.city.trim();
  const state = form.state.trim().toUpperCase();
  const areaValid = /^\d{5}$/.test(zip) || (city.length > 1 && /^[A-Z]{2}$/.test(state));

  function saveArea(event: FormEvent) {
    event.preventDefault();
    if (!areaValid) return;
    dispatch(areaSet(/^\d{5}$/.test(zip) ? { zip } : { city, state }));
    setChangingArea(false);
  }

  async function locate() {
    if (!effectiveArea || toLocate.length === 0) return;
    const response = await geocode({
      area: effectiveArea,
      addresses: toLocate.map((d) => ({ id: String(d.stopNumber), address: d.addressRaw, ...(d.zip ? { zip: d.zip } : {}) })),
    });
    if ('data' in response && response.data) dispatch(stopsLocated(response.data.results));
  }

  return (
    <section className="card">
      <h2>Locate stops</h2>

      {editingArea ? (
        <form onSubmit={saveArea}>
          <p className="muted small">
            {zips.length > 0
              ? 'Some stops have no ZIP. Set your route area once for them.'
              : 'The manifest has no city or ZIP. Set your route area once.'}
          </p>
          <div className="field-row" style={{ marginTop: 10 }}>
            <label className="field narrow wide-narrow">
              <span>ZIP</span>
              <input inputMode="numeric" maxLength={5} value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} />
            </label>
            <p className="muted small hint">Any ZIP on your route. Stops in nearby ZIPs are found too.</p>
          </div>
          <p className="muted small or-line">or</p>
          <div className="field-row">
            <label className="field">
              <span>City</span>
              <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </label>
            <label className="field narrow">
              <span>State</span>
              <input maxLength={2} autoCapitalize="characters" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
            </label>
          </div>
          <div className="row">
            <button type="submit" className="button primary" disabled={!areaValid}>Save area</button>
            {area && <button type="button" className="button ghost" onClick={() => setChangingArea(false)}>Cancel</button>}
          </div>
        </form>
      ) : (
        <>
          <p className="muted small">
            {ownZips ? (
              <>ZIP from the manifest: <strong className="text">{zips.join(', ')}</strong>{' '}</>
            ) : (
              <>Area: <strong className="text">{effectiveArea && describeArea(effectiveArea)}</strong>{' '}</>
            )}
            {!ownZips && (
              <button className="link" onClick={() => { setForm({ zip: area?.zip ?? '', city: area?.city ?? '', state: area?.state ?? '' }); setChangingArea(true); }}>change</button>
            )}
          </p>

          {(counts.ok + counts.review + counts.not_found > 0) && (
            <div className="geo-summary">
              <span className="good">● {counts.ok} on map</span>
              {counts.review > 0 && <span className="amber-text">● {counts.review} to check</span>}
              {counts.not_found > 0 && <span className="bad">● {counts.not_found} not found</span>}
              {counts.error > 0 && <span className="bad">● {counts.error} failed</span>}
              {provider && <span className="muted">via {provider === 'census' ? 'US Census' : 'Google'}</span>}
            </div>
          )}

          <div className="row">
            <button className="button primary" disabled={isLoading || toLocate.length === 0} onClick={locate}>
              {isLoading
                ? `Locating ${toLocate.length} stops…`
                : toLocate.length > 0
                  ? `Locate ${toLocate.length} stop${toLocate.length === 1 ? '' : 's'}`
                  : 'All stops located'}
            </button>
          </div>
          {error && <p className="bad small">Could not reach the server to locate stops.</p>}
        </>
      )}
    </section>
  );
}
