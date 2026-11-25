import { useAppDispatch, useAppSelector } from '../../store';
import { settingsChanged } from '../../store/routeSlice';

/** Driver preferences that rarely change; kept on the phone across routes. */
export function DriverSettingsPanel({ onVoiceEnabled }: { onVoiceEnabled: () => void }) {
  const dispatch = useAppDispatch();
  const settings = useAppSelector((s) => s.route.settings);

  return (
    <details className="driver-settings">
      <summary className="muted small">Driving settings</summary>
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
      <p className="muted small">
        Private driveways and which side the house is on need road entry points, which come from Google (with the API key).
      </p>
    </details>
  );
}
