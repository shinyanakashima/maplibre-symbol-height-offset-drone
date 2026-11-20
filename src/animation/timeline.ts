/**
 * ウェイポイント間を直線でつないだ「推定」タイムライン。
 * 実機は加減速・旋回・ホバリング・アクション実行・風の影響を受けるため、実際の飛行軌跡・時間とは一致しない。
 */

export interface TimelinePoint {
  lng: number;
  lat: number;
  /** 標高（ジオイド基準, m）。決まらない場合は null */
  absolute: number | null;
  /** 地表からの高さ（表示用） */
  agl: number;
  /** この点から次の点へ向かう速度（m/s）。null は不明 */
  speed: number | null;
  label: string;
}

export interface Segment {
  from: TimelinePoint;
  to: TimelinePoint;
  start: number;
  duration: number;
  distance: number;
  speed: number;
  speedAssumed: boolean;
}

export interface Timeline {
  segments: Segment[];
  totalTime: number;
  totalDistance: number;
  /** 速度を仮定した区間がある */
  usesAssumedSpeed: boolean;
}

export interface TimelineState {
  lng: number;
  lat: number;
  agl: number;
  absolute: number | null;
  segmentIndex: number;
  fromLabel: string;
  toLabel: string;
  speed: number;
}

const R = 6378137;

/** 2 点間の水平距離（m、正距円筒近似。数 km 程度のミッションでは十分） */
export function horizontalDistance(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const lat0 = (((a.lat + b.lat) / 2) * Math.PI) / 180;
  const dx = (((b.lng - a.lng) * Math.PI) / 180) * Math.cos(lat0) * R;
  const dy = (((b.lat - a.lat) * Math.PI) / 180) * R;
  return Math.hypot(dx, dy);
}

export function buildTimeline(points: TimelinePoint[], defaultSpeed = 5): Timeline {
  const segments: Segment[] = [];
  let t = 0;
  let dist = 0;
  let assumed = false;
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    const h = horizontalDistance(from, to);
    const dz = from.absolute !== null && to.absolute !== null ? to.absolute - from.absolute : to.agl - from.agl;
    const distance = Math.hypot(h, dz);
    const speedAssumed = !(from.speed !== null && from.speed > 0);
    const speed = speedAssumed ? defaultSpeed : (from.speed as number);
    if (speedAssumed) assumed = true;
    const duration = distance / speed;
    segments.push({ from, to, start: t, duration, distance, speed, speedAssumed });
    t += duration;
    dist += distance;
  }
  return { segments, totalTime: t, totalDistance: dist, usesAssumedSpeed: assumed };
}

/**
 * 時刻 t における位置。高さは標高が分かる場合は標高を直線補間し（機体は 2 点間を直線で結ぶ想定）、
 * AGL は呼び出し側で地表標高を引いて求める。標高が不明な場合は AGL を直線補間する。
 */
export function stateAt(tl: Timeline, t: number): TimelineState | null {
  if (tl.segments.length === 0) return null;
  const time = Math.min(Math.max(t, 0), tl.totalTime);
  let idx = tl.segments.findIndex((s) => time <= s.start + s.duration);
  if (idx < 0) idx = tl.segments.length - 1;
  const s = tl.segments[idx];
  const f = s.duration > 0 ? (time - s.start) / s.duration : 1;
  const lerp = (a: number, b: number) => a + (b - a) * f;
  return {
    lng: lerp(s.from.lng, s.to.lng),
    lat: lerp(s.from.lat, s.to.lat),
    agl: lerp(s.from.agl, s.to.agl),
    absolute: s.from.absolute !== null && s.to.absolute !== null ? lerp(s.from.absolute, s.to.absolute) : null,
    segmentIndex: idx,
    fromLabel: s.from.label,
    toLabel: s.to.label,
    speed: s.speed,
  };
}

export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
