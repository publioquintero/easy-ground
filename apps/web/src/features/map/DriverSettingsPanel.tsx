import { useAppDispatch, useAppSelector } from '../../store';
import { settingsChanged } from '../../store/routeSlice';
import type { RightSideMode } from '@easy-ground/core';

/** Driver preferences that rarely change; kept on the phone across routes. */
export function DriverSettingsPanel({
  onVoiceEnabled,
  onRightSide,
  rightSideDisabled,
}: {
  onVoiceEnabled: () => void;
  /** Changing the side re-optimizes the route, so the map card handles it. */
  onRightSide: (mode: RightSideMode) => void;
  rightSideDisabled: boolean;
}) {
  const dispatch = useAppDispatch();
  const settings = useAppSelector((s) => s.route.settings);

  return (
    <details className="driver-settings">
      <summary className="muted small">Driving settings</summary>
      <div className="field">
        <span>House side when optimizing</span>
        <div className="segmented side-toggle" role="group" aria-label="Right side">
          {(['off', 'prefer', 'strict'] as const).map((mode) => (
            <button key={mode} className={settings.rightSide === mode ? 'on' : ''} disabled={rightSideDisabled} onClick={() => onRightSide(mode)}>
              {mode === 'off' ? 'Any side' : mode === 'prefer' ? 'Prefer right' : 'Right only'}
            </button>
          ))}
        </div>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.voiceAlerts}
          onChange={(e) => {
            dispatch(settingsChanged({ voiceAlerts: e.target.checked }));
            // iOS only lets a page speak after a tap: this tap unlocks it.
            if (e.target.checked) onVoiceEnabled();
          }}
        />
        Spoken alert 150 m before a private driveway
      </label>
      <label className="field driveway-field">
        <span>Private driveway when the house is farther than (m)</span>
        <input
          type="number"
          inputMode="numeric"
          min={20}
          max={500}
          step={5}
          // Saved on blur so typing "120" doesn't pass through an invalid "1".
          key={settings.drivewayThresholdM}
          defaultValue={settings.drivewayThresholdM}
          onBlur={(e) => {
            const value = Math.round(Number(e.target.value));
            if (Number.isFinite(value) && value >= 20 && value <= 500) dispatch(settingsChanged({ drivewayThresholdM: value }));
            else e.target.value = String(settings.drivewayThresholdM);
          }}
        />
      </label>
      <label className="field driveway-field">
        <span>Businesses close at</span>
        <input
          type="time"
          value={settings.businessCloseAt}
          onChange={(e) => e.target.value && dispatch(settingsChanged({ businessCloseAt: e.target.value }))}
        />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Pickups from</span>
          <input
            type="time"
            value={settings.pickupWindow.from}
            onChange={(e) => e.target.value && dispatch(settingsChanged({ pickupWindow: { ...settings.pickupWindow, from: e.target.value } }))}
          />
        </label>
        <label className="field">
          <span>Pickups until</span>
          <input
            type="time"
            value={settings.pickupWindow.to}
            onChange={(e) => e.target.value && dispatch(settingsChanged({ pickupWindow: { ...settings.pickupWindow, to: e.target.value } }))}
          />
        </label>
      </div>
      <p className="muted small">Default pickup window. Change it per pickup in its stop details.</p>
      <label className="field driveway-field">
        <span>Minutes at each stop (for arrival times)</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={30}
          step={1}
          key={settings.stopMinutes}
          defaultValue={settings.stopMinutes}
          onBlur={(e) => {
            const value = Math.round(Number(e.target.value));
            if (Number.isFinite(value) && value >= 0 && value <= 30) dispatch(settingsChanged({ stopMinutes: value }));
            else e.target.value = String(settings.stopMinutes);
          }}
        />
      </label>
      <p className="muted small">
        Private driveways and which side the house is on need road entry points, which come from Google (with the API key).
      </p>
    </details>
  );
}
