import { useMemo, useState } from 'react';
import type { StopDraft } from '@easy-ground/core';
import { useAppDispatch, useAppSelector } from '../store';
import {
  issueDismissed,
  nextFreeStopNumber,
  stopAdded,
  stopRemoved,
  stopReviewed,
  stopUpdated,
} from '../store/routeSlice';
import { StopEditor } from './StopEditor';

const ISSUE_LABEL: Record<string, string> = {
  truncated_address: 'Truncated address',
  missing_field: 'Missing field',
  duplicate_stop: 'Duplicate',
  suspect_house_number: 'Check address',
  inferred_stop_number: 'Stop # guessed',
};

const NEW = 'new' as const;

export function StopReviewList() {
  const dispatch = useAppDispatch();
  const { drafts, issues, sourceName, geo } = useAppSelector((s) => s.route);
  const [editing, setEditing] = useState<number | typeof NEW | null>(null);

  const issuesByStop = useMemo(() => {
    const map = new Map<number, string[]>();
    const add = (stopNumber: number, label: string) => {
      const labels = map.get(stopNumber) ?? [];
      if (!labels.includes(label)) map.set(stopNumber, [...labels, label]);
    };
    for (const issue of issues) {
      if (issue.stopNumber === undefined || issue.kind === 'duplicate_stop') continue;
      add(issue.stopNumber, ISSUE_LABEL[issue.kind] ?? issue.kind);
    }
    for (const [stopNumber, result] of Object.entries(geo)) {
      if (result.status === 'review') add(Number(stopNumber), 'Check map match');
      if (result.status === 'not_found') add(Number(stopNumber), 'Not found on map');
    }
    return map;
  }, [issues, geo]);
  const generalIssues = issues.filter((i) => i.stopNumber === undefined);
  const takenNumbers = drafts.map((d) => d.stopNumber);

  if (drafts.length === 0 && generalIssues.length === 0) return null;

  const pending = drafts.filter((d) => !d.completed);
  const packages = pending.reduce((sum, d) => sum + d.packageCount, 0);
  const flaggedStops = drafts.filter((d) => issuesByStop.has(d.stopNumber));

  const blankStop: StopDraft = {
    stopNumber: nextFreeStopNumber(drafts),
    stopType: 'delivery',
    shelfId: null,
    packageCount: 1,
    customerName: null,
    addressRaw: '',
    addressLine2: null,
    completed: false,
  };

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Review</h2>
          <p className="muted small">{sourceName}</p>
        </div>
        {flaggedStops.length > 0 && editing === null && (
          <button className="button amber-btn" onClick={() => setEditing(flaggedStops[0].stopNumber)}>
            Review next ({flaggedStops.length})
          </button>
        )}
      </div>

      <div className="stats">
        <div><strong>{pending.length}</strong><span>pending</span></div>
        <div><strong>{packages}</strong><span>packages</span></div>
        <div><strong>{drafts.length - pending.length}</strong><span>completed</span></div>
        <div className={flaggedStops.length ? 'amber' : ''}><strong>{flaggedStops.length}</strong><span>to review</span></div>
      </div>

      {generalIssues.map((issue, idx) => (
        <div key={idx} className="general-issue">
          <p className="small">
            <strong>{issue.kind === 'unparsed_row' ? 'Unread row' : 'Problem'}</strong> (image/page {issue.page}): {issue.detail}
          </p>
          <div className="row tight">
            {issue.kind === 'unparsed_row' && (
              <button className="button small-btn" onClick={() => setEditing(NEW)}>Add as stop</button>
            )}
            <button className="button ghost small-btn" onClick={() => dispatch(issueDismissed(idx))}>Dismiss</button>
          </div>
        </div>
      ))}

      <ol className="stops">
        {drafts.map((d) => {
          const flags = issuesByStop.get(d.stopNumber);
          const isEditing = editing === d.stopNumber;
          return (
            <li key={d.stopNumber} className={`stop-item${isEditing ? ' editing' : ''}`}>
              <button
                type="button"
                className={`stop${d.completed ? ' done' : ''}${flags ? ' flagged' : ''}`}
                aria-expanded={isEditing}
                onClick={() => setEditing(isEditing ? null : d.stopNumber)}
              >
                <span className="num">
                  {d.stopNumber}
                  {geo[d.stopNumber]?.status === 'ok' && <span className="located" title="On the map" />}
                </span>
                <div className="body">
                  <div className="addr">
                    {d.addressRaw || <span className="bad">No address</span>}
                    {d.addressLine2 && <span className="addr2"> · {d.addressLine2}</span>}
                  </div>
                  <div className="meta">
                    {d.customerName}
                    {geo[d.stopNumber]?.formatted && geo[d.stopNumber].status !== 'ok' && (
                      <span className="match">→ {geo[d.stopNumber].formatted}</span>
                    )}
                    {d.business && <span className="tag business">Business</span>}
                    {d.stopType === 'pickup' && <span className="tag pickup">Pickup</span>}
                    {d.source === 'label' && <span className="tag pickup">From label</span>}
                    {d.completed && <span className="tag">Completed</span>}
                    {flags?.map((f) => <span key={f} className="tag amber">{f}</span>)}
                  </div>
                </div>
                <div className="pkg">
                  <strong>{d.packageCount}</strong>
                  <span>SID {d.shelfId ?? '—'}</span>
                </div>
              </button>
              {isEditing && (
                <StopEditor
                  key={d.stopNumber}
                  stop={d}
                  flags={flags}
                  takenNumbers={takenNumbers}
                  onCancel={() => setEditing(null)}
                  onSave={(changes) => {
                    dispatch(stopUpdated({ stopNumber: d.stopNumber, changes }));
                    setEditing(null);
                  }}
                  onLooksRight={flags ? () => { dispatch(stopReviewed(d.stopNumber)); setEditing(null); } : undefined}
                  onDelete={() => {
                    dispatch(stopRemoved(d.stopNumber));
                    setEditing(null);
                  }}
                />
              )}
            </li>
          );
        })}
      </ol>

      {editing === NEW ? (
        <div className="new-stop">
          <h3>New stop</h3>
          <StopEditor
            stop={blankStop}
            isNew
            takenNumbers={takenNumbers}
            onCancel={() => setEditing(null)}
            onSave={(stop) => {
              dispatch(stopAdded(stop));
              setEditing(null);
            }}
          />
        </div>
      ) : (
        <div className="row">
          <button className="button ghost" onClick={() => setEditing(NEW)}>+ Add stop</button>
        </div>
      )}
    </section>
  );
}
