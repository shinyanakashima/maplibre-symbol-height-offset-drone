/**
 * サンプル KMZ を public/samples/ に生成する。
 *   npm run samples
 *
 * WGS84（楕円体高）や EGM96 のサンプルは、地理院 DEM と国土地理院ジオイド計算サービスで求めた
 * ジオイド高（下記 GEOID_FLAT）から「意図した対地高度」になるよう逆算して作っている。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { DemSampler } from '../src/terrain/gsiDem';
import { nodeGsiLoader } from './nodeDemLoader';
import { buildKmz, type SampleMission, type SampleWaypoint } from './wpmlBuilder';

/** 北緯42.88 東経143.10 のジオイド高（国土地理院 ジオイド2011 による計算値, m） */
const GEOID_FLAT = 29.47;

const dem = new DemSampler(nodeGsiLoader, 14);
const elev = (lng: number, lat: number) => {
  const h = dem.elevation(lng, lat);
  if (h === null) throw new Error(`DEM なし ${lng},${lat}`);
  return h;
};
const r2 = (v: number) => Math.round(v * 100) / 100;

const out = 'public/samples';
mkdirSync(out, { recursive: true });

interface Entry {
  file: string;
  title: string;
  description: string;
  geoidHeight?: number;
}
const entries: Entry[] = [];

async function save(file: string, m: SampleMission, title: string, description: string, geoidHeight?: number) {
  writeFileSync(`${out}/${file}`, await buildKmz(m));
  entries.push({ file, title, description, geoidHeight });
  console.log('wrote', file);
}

// ---------- 1. 平坦な地形（帯広市西部の畑地）: 離陸地点相対 60m のジグザグ ----------
{
  const lng0 = 143.1, lat0 = 42.88;
  const dLng = 0.0037, dLat = 0.00054;
  const pts: SampleWaypoint[] = [];
  for (let i = 0; i < 4; i++) {
    const lat = lat0 + i * dLat;
    const a = { lng: lng0, lat, height: 60 };
    const b = { lng: lng0 + dLng, lat, height: 60 };
    pts.push(...(i % 2 === 0 ? [a, b] : [b, a]));
  }
  const takeoff = { lng: lng0 - 0.0006, lat: lat0 - 0.0004 };
  await dem.preload([...pts.map((p) => [p.lng, p.lat] as [number, number]), [takeoff.lng, takeoff.lat]]);
  await save(
    'flat-relative.kmz',
    {
      takeOffRefPoint: { ...takeoff, ellipsoidHeight: r2(elev(takeoff.lng, takeoff.lat) + GEOID_FLAT) },
      waylines: [{ waylineId: 0, heightMode: 'relativeToStartPoint', autoFlightSpeed: 8, waypoints: pts }],
    },
    '平坦な地形（離陸地点相対 60m）',
    '帯広市西部の畑地。標高差が小さいため、離陸地点相対高度と地表からの高さがほぼ一致する。',
  );
}

// ---------- 2. 起伏のある地形（帯広市拓成町付近）: 谷から尾根へ 離陸地点相対 150m ----------
{
  const takeoff = { lng: 143.0415, lat: 42.6745 };
  const lngs = [143.04, 143.038, 143.036, 143.034, 143.032];
  const pts: SampleWaypoint[] = [
    ...lngs.map((lng) => ({ lng, lat: 42.6745, height: 150, speed: 6 })),
    ...[...lngs].reverse().map((lng) => ({ lng, lat: 42.6728, height: 150, speed: 6 })),
  ];
  await dem.preload([...pts.map((p) => [p.lng, p.lat] as [number, number]), [takeoff.lng, takeoff.lat]]);
  await save(
    'hilly-relative.kmz',
    {
      takeOffRefPoint: { ...takeoff, ellipsoidHeight: r2(elev(takeoff.lng, takeoff.lat) + 29.56) },
      waylines: [{ waylineId: 0, heightMode: 'relativeToStartPoint', autoFlightSpeed: 6, waypoints: pts }],
    },
    '起伏のある地形（離陸地点相対 150m）',
    '帯広市拓成町付近。谷で離陸し尾根へ向かうため、離陸地点相対 150m でも尾根付近では地表より下になる。',
    29.56,
  );
}

// ---------- 3. 複数 wayline + 楕円体高（WGS84）+ 異なる高度 ----------
{
  const c = { lng: 143.106, lat: 42.8815 };
  const agl0 = [40, 60, 80, 100, 80, 60];
  const ring = [
    [0, 0], [0.0025, 0], [0.0025, 0.0015], [0.0012, 0.0022], [0, 0.0015], [0, 0.0004],
  ];
  const wl0 = ring.map(([dx, dy], i) => ({ lng: c.lng + dx, lat: c.lat + dy, agl: agl0[i] }));
  const wl1 = [0, 1, 2, 3, 4].map((i) => ({ lng: c.lng - 0.001 + i * 0.0009, lat: c.lat - 0.0012, agl: 30 + i * 22.5 }));
  await dem.preload([...wl0, ...wl1].map((p) => [p.lng, p.lat] as [number, number]));
  const toEll = (p: { lng: number; lat: number; agl: number }) => ({
    lng: p.lng,
    lat: p.lat,
    height: r2(elev(p.lng, p.lat) + p.agl + GEOID_FLAT),
  });
  await save(
    'multi-wayline-wgs84.kmz',
    {
      waylines: [
        { waylineId: 0, heightMode: 'WGS84', autoFlightSpeed: 7, waypoints: wl0.map(toEll) },
        { waylineId: 1, heightMode: 'WGS84', autoFlightSpeed: 5, waypoints: wl1.map(toEll) },
      ],
    },
    '複数 wayline・楕円体高（WGS84）',
    `wayline 0 は対地 40〜100m、wayline 1 は 30〜120m の上昇。ジオイド高 ${GEOID_FLAT}m を入力すると意図した対地高度になる。`,
    GEOID_FLAT,
  );
}

// ---------- 4. 異なる高度モードの混在 ----------
{
  const lat = 42.8848;
  const takeoff = { lng: 143.0995, lat: lat - 0.0005 };
  const line = (lat: number, h: number) =>
    [0, 1, 2, 3].map((i) => ({ lng: 143.1 + i * 0.0012, lat, height: h }));
  await dem.preload([[takeoff.lng, takeoff.lat], ...line(lat, 0).map((p) => [p.lng, p.lat] as [number, number])]);
  await dem.preload(line(lat + 0.0006, 0).map((p) => [p.lng, p.lat] as [number, number]));
  await save(
    'mixed-height-modes.kmz',
    {
      takeOffRefPoint: { ...takeoff, ellipsoidHeight: r2(elev(takeoff.lng, takeoff.lat) + GEOID_FLAT) },
      waylines: [
        { waylineId: 0, heightMode: 'relativeToStartPoint', autoFlightSpeed: 8, waypoints: line(lat, 50) },
        { waylineId: 1, heightMode: 'realTimeFollowSurface', autoFlightSpeed: 8, waypoints: line(lat + 0.0006, 15) },
        { waylineId: 2, heightMode: 'unknownHeightMode', autoFlightSpeed: 8, waypoints: line(lat + 0.0012, 70) },
      ],
    },
    '異なる高度モード（テスト用）',
    'wayline 0 は離陸地点相対、1 はリアルタイム地表追従（参考表示）、2 は未知のモード（変換しない）。',
  );
}

// ---------- 5. template.kml のみ（EGM96 の海抜高度で記述したウェイポイント） ----------
{
  const pts = [0, 1, 2, 3, 4].map((i) => ({ lng: 143.094 + i * 0.0008, lat: 42.8785 + (i % 2) * 0.0006 }));
  await dem.preload(pts.map((p) => [p.lng, p.lat] as [number, number]));
  const wps = pts.map((p, i) => ({ ...p, height: r2(elev(p.lng, p.lat) + 45 + i * 5) }));
  await save(
    'template-only-egm96.kmz',
    {
      omitWaylines: true,
      waylines: [{ waylineId: 0, heightMode: 'EGM96', autoFlightSpeed: 6, waypoints: wps }],
      templateEllipsoid: (wp) => r2(wp.height + GEOID_FLAT),
    },
    'template.kml のみ（EGM96）',
    'waylines.wpml を含まない KMZ。template.kml の wpml:height（EGM96 海抜高度）から表示する。',
  );
}

// ---------- 6. template.kml のみ（mapping2d: Mavic 3M の典型的な測量テンプレート） ----------
{
  await save(
    'template-only-mapping2d.kmz',
    {
      omitWaylines: true,
      waylines: [],
      takeOffRefPoint: { lat: 42.8795, lng: 143.0905, ellipsoidHeight: 120 },
      mappingPolygon: [
        [143.091, 42.8798], [143.0952, 42.8798], [143.0955, 42.8822], [143.0908, 42.8825], [143.091, 42.8798],
      ],
    },
    'template.kml のみ（mapping2d）',
    '測量エリアだけを持つテンプレート。経路は DJI Pilot 2 が生成するため、エリアのみ表示される。',
  );
}

writeFileSync(`${out}/index.json`, JSON.stringify(entries, null, 2) + '\n');
console.log('wrote index.json');
