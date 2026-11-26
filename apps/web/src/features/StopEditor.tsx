import { useState, type FormEvent } from 'react';
import type { StopDraft } from '@easy-ground/core';
import { useAppSelector } from '../store';

interface Props {
  stop: StopDraft;
  /** Why this stop was flagged, shown so the driver knows what to check. */
  flags?: string[];
  takenNumbers: number[];
  isNew?: boolean;
  onSave: (changes: StopDraft) => void;
  onCancel: () => void;
  onDelete?: () => void;
  onLooksRight?: () => void;
}

const asInt = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN);

export function StopEditor({ stop, flags, takenNumbers, isNew, onSave, onCancel, onDelete, onLooksRight }: Props) {
  const defaultWindow = useAppSelector((s) => s.route.settings.pickupWindow);
  const [form, setForm] = useState({
    windowFrom: (stop.pickupWindow ?? defaultWindow).from,
    windowTo: (stop.pickupWindow ?? defaultWindow).to,
    stopNumber: String(stop.stopNumber),
    addressRaw: stop.addressRaw,
    addressLine2: stop.addressLine2 ?? '',
    customerName: stop.customerName ?? '',
    packageCount: String(stop.packageCount),
    shelfId: stop.shelfId ?? '',
    stopType: stop.stopType,
    completed: stop.completed,
    business: stop.business ?? false,
  });
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const stopNumber = asInt(form.stopNumber);
  const packageCount = asInt(form.packageCount);
  const address = form.addressRaw.replace(/\s+/g, ' ').trim().toUpperCase();
  const errors = {
    stopNumber: !(stopNumber > 0)
      ? 'Enter a stop number'
      : stopNumber !== stop.stopNumber && takenNumbers.includes(stopNumber)
        ? `Stop ${stopNumber} already exists`
        : null,
    addressRaw: !/^\d+\S*\s+\S+/.test(address) ? 'House number and street, e.g. 8131 OAKVIEW DR N' : null,
    packageCount: !(packageCount >= 0) ? 'Enter a number' : null,
    window: form.stopType === 'pickup' && !(form.windowFrom < form.windowTo) ? 'The window must end after it starts' : null,
  };
  const valid = Object.values(errors).every((e) => e === null);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    const clean = (s: string) => s.replace(/\s+/g, ' ').trim().toUpperCase() || null;
    onSave({
      stopNumber,
      stopType: form.stopType,
      shelfId: clean(form.shelfId),
      packageCount,
      customerName: clean(form.customerName),
      addressRaw: address.replace(/(…|\.+)$/, ''),
      addressLine2: clean(form.addressLine2),
      completed: form.completed,
      business: form.business,
      // Only a window different from the default is kept, so changing the default applies to the rest.
      pickupWindow:
        form.stopType === 'pickup' && (form.windowFrom !== defaultWindow.from || form.windowTo !== defaultWindow.to)
          ? { from: form.windowFrom, to: form.windowTo }
          : null,
    });
  }

  return (
    <form className="editor" onSubmit={submit}>
      {flags && flags.length > 0 && (
        <p className="editor-flags">Check: {flags.join(', ').toLowerCase()}</p>
      )}

      <div className="field-row">
        <label className="field narrow">
          <span>Stop #</span>
          <input inputMode="numeric" value={form.stopNumber} onChange={(e) => set('stopNumber', e.target.value)} />
        </label>
        <label className="field">
          <span>Address</span>
          <input
            value={form.addressRaw}
            autoCapitalize="characters"
            autoFocus={isNew || Boolean(flags?.length)}
            onChange={(e) => set('addressRaw', e.target.value)}
          />
        </label>
      </div>
      {(errors.stopNumber || errors.addressRaw) && (
        <p className="field-error">{errors.stopNumber ?? errors.addressRaw}</p>
      )}

      <div className="field-row">
        <label className="field">
          <span>Address 2</span>
          <input value={form.addressLine2} autoCapitalize="characters" placeholder="APT, UNIT…" onChange={(e) => set('addressLine2', e.target.value)} />
        </label>
        <label className="field">
          <span>Name</span>
          <input value={form.customerName} autoCapitalize="characters" onChange={(e) => set('customerName', e.target.value)} />
        </label>
      </div>

      <div className="field-row">
        <label className="field narrow">
          <span>Pkgs</span>
          <input inputMode="numeric" value={form.packageCount} onChange={(e) => set('packageCount', e.target.value)} />
        </label>
        <label className="field narrow">
          <span>SID</span>
          <input inputMode="numeric" value={form.shelfId} onChange={(e) => set('shelfId', e.target.value)} />
        </label>
        <div className="field">
          <span>Type</span>
          <div className="segmented">
            {(['delivery', 'pickup'] as const).map((t) => (
              <button type="button" key={t} className={form.stopType === t ? 'on' : ''} onClick={() => set('stopType', t)}>
                {t === 'delivery' ? 'Delivery' : 'Pickup'}
              </button>
            ))}
          </div>
        </div>
      </div>
      {errors.packageCount && <p className="field-error">Pkgs: {errors.packageCount}</p>}

      {form.stopType === 'pickup' && (
        <>
          <div className="field-row">
            <label className="field">
              <span>Pickup from</span>
              <input type="time" value={form.windowFrom} onChange={(e) => e.target.value && set('windowFrom', e.target.value)} />
            </label>
            <label className="field">
              <span>Pickup until</span>
              <input type="time" value={form.windowTo} onChange={(e) => e.target.value && set('windowTo', e.target.value)} />
            </label>
          </div>
          {errors.window && <p className="field-error">{errors.window}</p>}
        </>
      )}

      <label className="check">
        <input type="checkbox" checked={form.business} onChange={(e) => set('business', e.target.checked)} />
        Business (delivered first, before it closes)
      </label>
      <label className="check">
        <input type="checkbox" checked={form.completed} onChange={(e) => set('completed', e.target.checked)} />
        Already delivered / attempted (skip in route)
      </label>

      <div className="row">
        <button type="submit" className="button primary" disabled={!valid}>
          {isNew ? 'Add stop' : 'Save'}
        </button>
        {onLooksRight && (
          <button type="button" className="button" onClick={onLooksRight}>
            Looks right
          </button>
        )}
        <button type="button" className="button ghost" onClick={onCancel}>
          Cancel
        </button>
        {onDelete && (
          <button
            type="button"
            className={`button ghost danger push-right${confirmDelete ? ' armed' : ''}`}
            onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
          >
            {confirmDelete ? 'Tap again to delete' : 'Delete'}
          </button>
        )}
      </div>
    </form>
  );
}
