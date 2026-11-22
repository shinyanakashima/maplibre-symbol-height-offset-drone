import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseKmz } from '../src/wpml/parser';
import {
  chooseTakeoff, missionBounds, polygonsToGeoJSON, resolveWaypoints, routesToGeoJSON, waypointsToGeoJSON,
} from '../src/wpml/geojson';
import { buildKmz } from '../scripts/wpmlBuilder';

const flatGround = () => 100;

describe('GeoJSON 変換', () => {
  it('離陸地点相対の WP を AGL / 標高の属性付き Point にする', async () => {
    const m = await parseKmz(
      await buildKmz({
        takeOffRefPoint: { lat: 42.88, lng: 143.1, ellipsoidHeight: 130 },
        waylines: [
          { waylineId: 0, heightMode: 'relativeToStartPoint', autoFlightSpeed: 5, waypoints: [
            { lng: 143.1, lat: 42.88, height: 60 }, { lng: 143.101, lat: 42.88, height: 70 },
          ] },
          { waylineId: 1, heightMode: 'fooMode', autoFlightSpeed: 5, waypoints: [
            { lng: 143.102, lat: 42.88, height: 60 }, { lng: 143.103, lat: 42.88, height: 70 },
          ] },
        ],
      }),
    );
    const t = chooseTakeoff(m, null)!;
    expect(t.source).toBe('takeOffRefPoint');
    const wps = resolveWaypoints(m, {
      elevation: (lng) => (lng > 143.1005 ? 110 : 100),
      takeoff: { ...t, groundElevation: 100 },
      geoidHeight: null,
    });
    const fc = waypointsToGeoJSON(wps, [0, 1]);
    expect(fc.features).toHaveLength(4);
    expect(fc.features[0].properties).toMatchObject({ id: '0-0', heightAGL: 60, heightAbs: 160, status: 'ok', colorIndex: 0 });
    expect(fc.features[1].properties).toMatchObject({ heightAGL: 60, heightAbs: 170 });
    // 未知のモードは地表に置く
    expect(fc.features[2].properties).toMatchObject({ status: 'unsupported', heightAGL: 0, heightAbs: 110, colorIndex: 1 });

    const routes = routesToGeoJSON(wps, [0, 1]);
    expect(routes.features).toHaveLength(2);
    expect(routes.features[0].geometry.coordinates).toEqual([[143.1, 42.88], [143.101, 42.88]]);
    expect(missionBounds(m)).toEqual([143.1, 42.88, 143.103, 42.88]);
  });

  it('離陸地点がない場合は最初の WP を仮定し、ユーザー指定を優先する', async () => {
    const m = await parseKmz(
      await buildKmz({ waylines: [{ waylineId: 0, heightMode: 'relativeToStartPoint', autoFlightSpeed: 5, waypoints: [{ lng: 1, lat: 2, height: 3 }] }] }),
    );
    expect(chooseTakeoff(m, null)).toEqual({ lng: 1, lat: 2, source: 'firstWaypoint' });
    expect(chooseTakeoff(m, { lng: 5, lat: 6 })).toEqual({ lng: 5, lat: 6, source: 'user' });
    const wps = resolveWaypoints(m, { elevation: flatGround, takeoff: { lng: 1, lat: 2, source: 'firstWaypoint', groundElevation: 100 }, geoidHeight: null });
    expect(wps[0].altitude.status).toBe('reference');
  });

  it('測量エリアのポリゴンを閉じる', async () => {
    const m = await parseKmz(
      await buildKmz({ omitWaylines: true, waylines: [], mappingPolygon: [[0, 0], [1, 0], [1, 1]] }),
    );
    const fc = polygonsToGeoJSON(m);
    expect(fc.features[0].geometry.type).toBe('Polygon');
    expect((fc.features[0].geometry as GeoJSON.Polygon).coordinates[0]).toHaveLength(4);
  });
});

describe('同梱サンプル KMZ', () => {
  const index = JSON.parse(readFileSync('public/samples/index.json', 'utf8')) as Array<{ file: string }>;
  for (const { file } of index) {
    it(`${file} を解析できる`, async () => {
      const m = await parseKmz(readFileSync(`public/samples/${file}`), file);
      expect(m.missionConfig.droneEnumValue).toBe(77);
      if (file.includes('mapping2d')) {
        expect(m.templateFolders[0].polygons).toHaveLength(1);
      } else {
        expect(m.waylines.length).toBeGreaterThan(0);
        for (const w of m.waylines) for (const p of w.waypoints) expect(p.executeHeight).not.toBeNull();
      }
    });
  }
});
