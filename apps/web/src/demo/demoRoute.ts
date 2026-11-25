import type { ParseResult, StopDraft } from '@easy-ground/core';
import type { RouteArea } from '../store/api';

/**
 * A demo route to try the app without a real manifest. Addresses are public buildings in
 * Washington, DC (museums, agencies); customer names are invented. Numbering is shuffled
 * on purpose so "Optimized" has something to improve, and a few stops carry the problems
 * real captures have (truncated address, pickup, already delivered, Address 2).
 */
export const DEMO_AREA: RouteArea = { city: 'WASHINGTON', state: 'DC' };

const stop = (
  stopNumber: number,
  addressRaw: string,
  customerName: string,
  extra: Partial<StopDraft> = {},
): StopDraft => ({
  stopNumber,
  stopType: 'delivery',
  shelfId: String(6000 + Math.floor((stopNumber - 1) / 3) * 13),
  packageCount: 1,
  customerName,
  addressRaw,
  addressLine2: null,
  completed: false,
  ...extra,
});

export const DEMO_ROUTE: ParseResult = {
  stops: [
    stop(1, '1600 PENNSYLVANIA AVE NW', 'ANA ALDEN', { completed: true }),
    stop(2, '50 MASSACHUSETTS AVE NE', 'BRIAN CORVIN', { packageCount: 2 }),
    stop(3, '1150 17TH ST NW', 'CARLA ESPARZA'),
    stop(4, '601 INDEPENDENCE AVE SW', 'DEV FINLEY', { packageCount: 3 }),
    stop(5, '1250 NEW YORK AVE NW', 'ELENA GARROWAY', { addressLine2: 'SUITE 200' }),
    stop(6, '101 INDEPENDENCE AVE SE', 'FRANK HOLLOWAY'),
    stop(7, '700 PENNSYLVANIA AVE NW', 'GINA IVERSEN', { packageCount: 2 }),
    stop(8, '1000 JEFFERSON DR SW', 'HUGO JUAREZ'),
    stop(9, '2 MASSACHUSETTS AVE NE', 'NORTHWIND SUPPLY LLC', { stopType: 'pickup' }),
    stop(10, '1400 CONSTITUTION AVE NW', 'IRIS KESTREL', { packageCount: 5 }),
    stop(11, '1 FIRST ST NE', 'JAMAL LINDQVIST'),
    stop(12, '401 F ST NW', 'KIRA MORROW', { packageCount: 2 }),
    stop(13, '950 PENNSYLVANIA AVE NW', 'LEO NAKAMURA'),
    stop(14, '1300 PENNSYLVANIA A…', 'MAYA OYELARAN', { addressLine2: 'APT 1425' }),
  ],
  issues: [{ kind: 'truncated_address', stopNumber: 14, page: 1, detail: '1300 PENNSYLVANIA A…' }],
};
