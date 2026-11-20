import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';
import { resolveAltitude, symbolOffsets, type AltitudeResult } from '../altitude/altitude';
import type { ParsedMission, WaypointRecord } from './types';

export type TakeoffSource = 'takeOffRefPoint' | 'user' | 'firstWaypoint';

export interface TakeoffPoint {
  lng: number;
  lat: number;
  source: TakeoffSource;
  groundElevation: number | null;
}

export interface ResolvedWaypoint extends WaypointRecord {
  /** 地図・一覧で使う一意キー */
  id: string;
  groundElevation: number | null;
  altitude: AltitudeResult;
  /** symbol-height-anchor: ground で使う値 */
  heightAGL: number;
  /** symbol-height-anchor: absolute で使う値 */
  heightAbs: number;
}

export const WAYLINE_COLORS = ['#e8590c', '#1c7ed6', '#2b8a3e', '#ae3ec9', '#f08c00', '#0b7285'];
export const waylineColor = (i: number) => WAYLINE_COLORS[i % WAYLINE_COLORS.length];

export function chooseTakeoff(
  mission: ParsedMission,
  userTakeoff: { lng: number; lat: number } | null,
): Omit<TakeoffPoint, 'groundElevation'> | null {
  if (userTakeoff) return { ...userTakeoff, source: 'user' };
  if (mission.takeoffRef) return { lng: mission.takeoffRef.lng, lat: mission.takeoffRef.lat, source: 'takeOffRefPoint' };
  const first = mission.waylines[0]?.waypoints[0];
  if (first) return { lng: first.lng, lat: first.lat, source: 'firstWaypoint' };
  return null;
}

export function resolveWaypoints(
  mission: ParsedMission,
  opts: {
    elevation: (lng: number, lat: number) => number | null;
    takeoff: TakeoffPoint | null;
    geoidHeight: number | null;
  },
): ResolvedWaypoint[] {
  const out: ResolvedWaypoint[] = [];
  for (const wl of mission.waylines) {
    for (const wp of wl.waypoints) {
      const ground = opts.elevation(wp.lng, wp.lat);
      const altitude = resolveAltitude(wp.heightMode, wp.executeHeight, {
        groundElevation: ground,
        takeoff: opts.takeoff
          ? { groundElevation: opts.takeoff.groundElevation, assumed: opts.takeoff.source === 'firstWaypoint' }
          : null,
        geoidHeight: opts.geoidHeight,
      });
      const { heightAGL, heightAbs } = symbolOffsets(altitude, ground);
      out.push({ ...wp, id: `${wp.waylineId}-${wp.index}`, groundElevation: ground, altitude, heightAGL, heightAbs });
    }
  }
  return out;
}

export function waypointsToGeoJSON(wps: ResolvedWaypoint[], waylineOrder: number[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: wps.map((wp, i) => ({
      type: 'Feature',
      id: i,
      geometry: { type: 'Point', coordinates: [wp.lng, wp.lat] },
      properties: {
        id: wp.id,
        waylineId: wp.waylineId,
        index: wp.index,
        label: String(wp.index),
        executeHeight: wp.executeHeight,
        heightMode: wp.heightMode,
        waypointSpeed: wp.waypointSpeed,
        groundElevation: wp.groundElevation,
        heightAGL: round(wp.heightAGL),
        heightAbs: round(wp.heightAbs),
        status: wp.altitude.status,
        belowGround: wp.altitude.belowGround,
        colorIndex: Math.max(0, waylineOrder.indexOf(wp.waylineId)) % WAYLINE_COLORS.length,
        color: waylineColor(Math.max(0, waylineOrder.indexOf(wp.waylineId))),
        heightLabel: wp.altitude.agl !== null ? `${Math.round(wp.altitude.agl)}m` : '?',
      },
    })),
  };
}

/** 地表に投影した 2D の経路（wayline ごと） */
export function routesToGeoJSON(wps: ResolvedWaypoint[], waylineOrder: number[]): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = [];
  for (const id of waylineOrder) {
    const pts = wps.filter((w) => w.waylineId === id);
    if (pts.length < 2) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lng, p.lat]) },
      properties: { waylineId: id, color: waylineColor(waylineOrder.indexOf(id)) },
    });
  }
  return { type: 'FeatureCollection', features };
}

export function polygonsToGeoJSON(mission: ParsedMission): FeatureCollection<Polygon | LineString> {
  const features: Feature<Polygon | LineString>[] = [];
  for (const f of mission.templateFolders) {
    for (const ring of f.polygons) {
      if (ring.length < 2) continue;
      const closed = ring.length >= 4 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
      features.push(
        ring.length >= 3
          ? {
              type: 'Feature',
              geometry: { type: 'Polygon', coordinates: [closed ? ring : [...ring, ring[0]]] },
              properties: { templateType: f.templateType },
            }
          : { type: 'Feature', geometry: { type: 'LineString', coordinates: ring }, properties: { templateType: f.templateType } },
      );
    }
  }
  return { type: 'FeatureCollection', features };
}

export function missionBounds(mission: ParsedMission): [number, number, number, number] | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  mission.waylines.forEach((wl) => wl.waypoints.forEach((w) => add(w.lng, w.lat)));
  mission.templateFolders.forEach((f) => f.polygons.forEach((r) => r.forEach(([x, y]) => add(x, y))));
  if (mission.takeoffRef) add(mission.takeoffRef.lng, mission.takeoffRef.lat);
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

const round = (v: number) => Math.round(v * 100) / 100;
