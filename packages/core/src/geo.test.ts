import { describe, expect, it } from 'vitest';
import { detectPrivateDriveway, distanceMeters } from './geo';

describe('distanceMeters', () => {
  it('is zero for the same point', () => {
    const p = { latitude: 34.05, longitude: -118.24 };
    expect(distanceMeters(p, p)).toBe(0);
  });

  it('matches ~111.2 km per degree of latitude', () => {
    const d = distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });
    expect(d).toBeGreaterThan(111_100);
    expect(d).toBeLessThan(111_300);
  });
});

describe('detectPrivateDriveway', () => {
  it('flags the plan example (~100 m) as a private driveway', () => {
    const r = detectPrivateDriveway(
      { latitude: 34.052235, longitude: -118.243683 },
      { latitude: 34.0531, longitude: -118.24412 },
    );
    expect(r.isPrivateDriveway).toBe(true);
    expect(r.drivewayDistanceM).toBeGreaterThan(90);
  });

  it('does not flag a short walk from the curb', () => {
    const r = detectPrivateDriveway(
      { latitude: 34.052235, longitude: -118.243683 },
      { latitude: 34.05235, longitude: -118.24372 },
    );
    expect(r.isPrivateDriveway).toBe(false);
  });
});
