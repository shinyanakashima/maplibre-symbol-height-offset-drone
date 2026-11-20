import './style.css';
import * as maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection, Point } from 'geojson';
import { heightModeLabel } from './altitude/altitude';
import { buildTimeline, formatDuration, stateAt, type Timeline } from './animation/timeline';
import { MapView, type AnchorMode, type Basemap, type RouteMode } from './map/mapView';
import type { Route3D } from './map/threeRouteLayer';
import { browserGsiLoader } from './terrain/browserDem';
import { DemSampler } from './terrain/gsiDem';
import { droneName, esc, m, n, STATUS_LABEL } from './ui/format';
import {
  chooseTakeoff,
  missionBounds,
  polygonsToGeoJSON,
  resolveWaypoints,
  routesToGeoJSON,
  waylineColor,
  waypointsToGeoJSON,
  type ResolvedWaypoint,
  type TakeoffPoint,
} from './wpml/geojson';
import { parseKmz } from './wpml/parser';
import type { ParsedMission } from './wpml/types';

interface SampleEntry {
  file: string;
  title: string;
  description: string;
  geoidHeight?: number;
}

const DEFAULT_SPEED = 5;

const state = {
  mission: null as ParsedMission | null,
  sample: null as SampleEntry | null,
  resolved: [] as ResolvedWaypoint[],
  takeoff: null as TakeoffPoint | null,
  userTakeoff: null as { lng: number; lat: number } | null,
  pickingTakeoff: false,
  geoidHeight: null as number | null,
  anchor: 'ground' as AnchorMode,
  terrain: true,
  exaggeration: 1,
  basemap: 'std' as Basemap,
  routeMode: 'both' as RouteMode,
  dropLines: true,
  overlap: true,
  heightLabels: false,
  selectedId: null as string | null,
  timeline: null as Timeline | null,
  playing: false,
  time: 0,
  playSpeed: 10,
  terrainCompare: null as Map<string, number | null> | null,
};

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const sampler = new DemSampler(browserGsiLoader, 14);
let popup: maplibregl.Popup | null = null;

const view = new MapView({
  container: $('#map'),
  onWaypointClick: (id, lngLat) => {
    selectWaypoint(id, false);
    showPopup(id, lngLat);
  },
  onMapClick: async (lngLat) => {
    if (!state.pickingTakeoff) return;
    state.pickingTakeoff = false;
    state.userTakeoff = { lng: lngLat.lng, lat: lngLat.lat };
    await sampler.preload([[lngLat.lng, lngLat.lat]]);
    recompute();
    toast('離陸地点を設定しました');
  },
});

// ---------------------------------------------------------------- 読み込み

async function loadKmz(data: ArrayBuffer, name: string, sample: SampleEntry | null) {
  try {
    const mission = await parseKmz(data, name);
    state.mission = mission;
    state.sample = sample;
    state.userTakeoff = null;
    state.selectedId = null;
    state.terrainCompare = null;
    state.geoidHeight = sample?.geoidHeight ?? null;
    stop();
    state.time = 0;
    $('#empty-hint').hidden = true;
    await view.whenReady();
    const pts: Array<[number, number]> = mission.waylines.flatMap((w) => w.waypoints.map((p) => [p.lng, p.lat] as [number, number]));
    if (mission.takeoffRef) pts.push([mission.takeoffRef.lng, mission.takeoffRef.lat]);
    toast('標高タイルを読み込み中…');
    await sampler.preload(pts);
    toast(`${name} を読み込みました`);
    recompute();
    const b = missionBounds(mission);
    if (b) view.fitTo(b);
    if (mission.waylines.length === 0) activateTab('debug');
  } catch (e) {
    console.error(e);
    toast(`読み込みに失敗しました: ${(e as Error).message}`, 6000);
  }
}

async function loadSample(file: string) {
  const list = await samplesPromise;
  const entry = list.find((s) => s.file === file) ?? null;
  const res = await fetch(`./samples/${file}`);
  if (!res.ok) {
    toast('サンプルを取得できませんでした');
    return;
  }
  await loadKmz(await res.arrayBuffer(), file, entry);
}

// ---------------------------------------------------------------- 計算と地図更新

function waylineOrder(): number[] {
  return state.mission?.waylines.map((w) => w.waylineId) ?? [];
}

function recompute() {
  const mission = state.mission;
  if (!mission) return;
  const base = chooseTakeoff(mission, state.userTakeoff);
  state.takeoff = base ? { ...base, groundElevation: sampler.elevation(base.lng, base.lat) } : null;
  state.resolved = resolveWaypoints(mission, {
    elevation: (lng, lat) => sampler.elevation(lng, lat),
    takeoff: state.takeoff,
    geoidHeight: state.geoidHeight,
  });
  const order = waylineOrder();
  // 仮定の離陸地点は、離陸地点相対の WP があるときだけ地図に出す（楕円体高などの計画では使わないため）
  const usesTakeoff = state.resolved.some((w) => w.heightMode === 'relativeToStartPoint');
  const showTakeoff = state.takeoff && (state.takeoff.source !== 'firstWaypoint' || usesTakeoff);
  const takeoffFc: FeatureCollection<Point> = {
    type: 'FeatureCollection',
    features: state.takeoff && showTakeoff
      ? [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [state.takeoff.lng, state.takeoff.lat] },
            properties: { label: state.takeoff.source === 'firstWaypoint' ? '離陸地点（仮定）' : '離陸地点' },
          },
        ]
      : [],
  };
  view.setMissionData({
    waypoints: waypointsToGeoJSON(state.resolved, order),
    routes: routesToGeoJSON(state.resolved, order),
    area: polygonsToGeoJSON(mission),
    takeoff: takeoffFc,
    routes3d: routes3d(),
  });
  view.setSelected(state.selectedId);
  state.timeline = buildTimeline(
    state.resolved.map((w) => ({
      lng: w.lng,
      lat: w.lat,
      absolute: w.altitude.absolute,
      agl: w.heightAGL,
      speed: w.waypointSpeed,
      label: `${w.waylineId}-${w.index}`,
    })),
    DEFAULT_SPEED,
  );
  updateDrone();
  renderAll();
}

/** 3D ラインの頂点の高さを、シンボルと同じ規則で求める */
function renderHeights(w: { groundElevation: number | null; heightAGL: number; heightAbs: number }) {
  const g = w.groundElevation ?? 0;
  const bottom = state.terrain ? g * state.exaggeration : 0;
  const top = state.anchor === 'ground' ? bottom + w.heightAGL : w.heightAbs;
  return { bottom, top };
}

function routes3d(): Route3D[] {
  return waylineOrder().map((id, i) => ({
    color: waylineColor(i),
    points: state.resolved.filter((w) => w.waylineId === id).map((w) => ({ lng: w.lng, lat: w.lat, ...renderHeights(w) })),
  }));
}

function refresh3d() {
  view.route3d.setRoutes(routes3d());
}

// ---------------------------------------------------------------- 選択・ポップアップ

function findWp(id: string | null) {
  return state.resolved.find((w) => w.id === id) ?? null;
}

function selectWaypoint(id: string | null, fly: boolean) {
  state.selectedId = id;
  view.setSelected(id);
  const wp = findWp(id);
  if (wp && fly) view.flyToPoint(wp.lng, wp.lat);
  renderWaypointsTab();
  const row = document.querySelector(`tr[data-wp="${id}"]`);
  row?.scrollIntoView({ block: 'nearest' });
}

function wpDetailHtml(wp: ResolvedWaypoint): string {
  const a = wp.altitude;
  return `<dl class="kv">
    <dt>ウェイポイント</dt><dd>wayline ${wp.waylineId} / #${wp.index}</dd>
    <dt>高度（ファイル値）</dt><dd>${m(wp.executeHeight, 2)}（${esc(heightModeLabel(wp.heightMode))}）</dd>
    <dt>地表からの高さ</dt><dd class="${a.belowGround ? 'below' : ''}">${m(a.agl)}</dd>
    <dt>標高</dt><dd>${m(a.absolute)}</dd>
    <dt>地表の標高</dt><dd>${m(wp.groundElevation)}</dd>
    <dt>速度</dt><dd>${wp.waypointSpeed === null ? '—' : `${wp.waypointSpeed} m/s`}${wp.speedSource === 'wayline' ? '（wayline 共通）' : ''}</dd>
    <dt>状態</dt><dd class="status-${a.status}">${STATUS_LABEL[a.status]}</dd>
  </dl>
  ${a.notes.length ? `<div class="notice ${a.belowGround ? 'danger' : ''}"><ul>${a.notes.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : ''}`;
}

function showPopup(id: string, lngLat: maplibregl.LngLat) {
  const wp = findWp(id);
  if (!wp) return;
  popup?.remove();
  popup = new maplibregl.Popup({ closeButton: true, maxWidth: '300px' }).setLngLat(lngLat).setHTML(wpDetailHtml(wp)).addTo(view.map);
}

// ---------------------------------------------------------------- パネル描画

function renderAll() {
  renderPlanTab();
  renderWaypointsTab();
  renderVerifyTab();
  renderDebugTab();
  $('#player').hidden = !(state.timeline && state.timeline.segments.length > 0);
  updatePlayerInfo();
}

function statusCounts() {
  const c = { ok: 0, reference: 0, unsupported: 0, below: 0 };
  for (const w of state.resolved) {
    c[w.altitude.status]++;
    if (w.altitude.belowGround) c.below++;
  }
  return c;
}

function renderPlanTab() {
  const el = $('#tab-plan');
  const ms = state.mission;
  if (!ms) {
    el.innerHTML = `<p>DJI Pilot 2 などで作成した飛行計画（KMZ）を読み込むと、ウェイポイントを MapLibre の
      <code>symbol-height-offset</code> で空中に表示します。</p>
      <p class="muted">KMZ の解析・標高の計算はすべてブラウザ内で行い、ファイルを外部に送信しません。地図・標高は国土地理院のタイルを使用します。</p>`;
    return;
  }
  const c = statusCounts();
  const tk = state.takeoff;
  const tkSource = tk
    ? { takeOffRefPoint: 'template.kml の takeOffRefPoint', user: '地図上で指定', firstWaypoint: '最初のウェイポイント直下と仮定' }[tk.source]
    : 'なし';
  const hasWgs84 = state.resolved.some((w) => w.heightMode === 'WGS84');
  const hasRelative = state.resolved.some((w) => w.heightMode === 'relativeToStartPoint');
  const tl = state.timeline;

  el.innerHTML = `
    <h3>ファイル</h3>
    <dl class="kv">
      <dt>ファイル名</dt><dd>${esc(ms.fileName)}</dd>
      ${state.sample ? `<dt>サンプル</dt><dd>${esc(state.sample.title)}</dd>` : ''}
      <dt>読み込み元</dt><dd>${esc(ms.source ?? '（ウェイポイントなし）')}</dd>
      <dt>機体</dt><dd>${esc(droneName(ms.missionConfig.droneEnumValue, ms.missionConfig.droneSubEnumValue))}</dd>
      <dt>wayline 数</dt><dd>${ms.waylines.length}</dd>
      <dt>WP 数</dt><dd>${state.resolved.length}</dd>
      ${tl && tl.segments.length ? `<dt>推定飛行時間</dt><dd>${formatDuration(tl.totalTime)}（${(tl.totalDistance / 1000).toFixed(2)} km、WP 間を直線で結んだ場合）</dd>` : ''}
    </dl>
    ${state.sample ? `<p class="muted">${esc(state.sample.description)}</p>` : ''}

    <h3>wayline と高度モード</h3>
    <table class="grid">
      <tr><th>wayline</th><th>高度モード</th><th>WP</th><th>速度</th></tr>
      ${ms.waylines
        .map(
          (w, i) => `<tr><td><span class="swatch" style="background:${waylineColor(i)}"></span>${w.waylineId}</td>
          <td style="text-align:left">${esc(heightModeLabel(w.heightMode))}</td><td>${w.waypoints.length}</td>
          <td>${w.autoFlightSpeed ?? '—'} m/s</td></tr>`,
        )
        .join('')}
    </table>

    <h3>高度の基準</h3>
    <div class="form-row">
      <label>離陸地点</label>
      <span>${esc(tkSource)}</span>
    </div>
    <div class="form-row">
      <label>離陸地点の標高</label><span>${m(tk?.groundElevation ?? null)}（地理院 DEM）</span>
    </div>
    <div class="form-row">
      <label></label>
      <button class="btn small" data-action="pick-takeoff">${state.pickingTakeoff ? '地図をクリック…' : '地図で離陸地点を指定'}</button>
      ${state.userTakeoff ? '<button class="btn small" data-action="reset-takeoff">元に戻す</button>' : ''}
    </div>
    ${
      hasRelative && tk?.source === 'firstWaypoint'
        ? '<div class="notice">KMZ に離陸地点（takeOffRefPoint）がないため、最初のウェイポイントの直下から離陸したと仮定しています。実際の離陸地点を地図で指定すると正しく換算できます。</div>'
        : ''
    }
    ${
      ms.takeoffRef?.aglHeight
        ? `<div class="notice info">takeOffRefPointAGLHeight = ${ms.takeoffRef.aglHeight} m が記録されています。仕様上の意味が確定できないため換算には使っていません。</div>`
        : ''
    }
    <div class="form-row">
      <label for="geoid">ジオイド高</label>
      <input id="geoid" type="number" step="0.01" placeholder="例 29.47" value="${state.geoidHeight ?? ''}" /> m
    </div>
    <p class="muted">楕円体高（WGS84）を標高に直すために使います（標高 = 楕円体高 − ジオイド高）。
      <a href="https://vldb.gsi.go.jp/sokuchi/surveycalc/geoid/calcgh/calc_f.html" target="_blank" rel="noopener">国土地理院のジオイド高計算</a>で確認できます。帯広周辺はおよそ 29〜30 m。</p>
    ${hasWgs84 && state.geoidHeight === null ? '<div class="notice">楕円体高のウェイポイントがあります。ジオイド高を入力するまで、それらは地表に「参考」として置いています。</div>' : ''}

    <h3>表示の状態</h3>
    <div class="legend">
      <span><i class="mark ok"></i>確定 ${c.ok}</span>
      <span><i class="mark reference"></i>参考 ${c.reference}</span>
      <span><i class="mark unsupported"></i>未対応（地表に配置）${c.unsupported}</span>
    </div>
    ${c.below ? `<div class="notice danger">${c.below} 個のウェイポイントが換算後に地表より下になります（高度検証タブ参照）。</div>` : ''}
    ${ms.warnings.length ? `<div class="notice"><b>解析時の注意 ${ms.warnings.length} 件</b><ul>${ms.warnings.slice(0, 5).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>${ms.warnings.length > 5 ? '（続きはデバッグタブ）' : ''}</div>` : ''}
  `;
}

function renderWaypointsTab() {
  const el = $('#tab-waypoints');
  if (!state.mission) {
    el.innerHTML = '<p class="muted">KMZ を読み込むと一覧が表示されます。</p>';
    return;
  }
  const order = waylineOrder();
  const rows = order
    .map((id, i) => {
      const wps = state.resolved.filter((w) => w.waylineId === id);
      return `<tr><th colspan="5" style="text-align:left"><span class="swatch" style="background:${waylineColor(i)}"></span>wayline ${id}</th></tr>
      ${wps
        .map(
          (w) => `<tr class="clickable ${w.id === state.selectedId ? 'selected' : ''}" data-wp="${w.id}">
            <td>#${w.index}</td><td>${n(w.executeHeight)}</td>
            <td class="${w.altitude.belowGround ? 'below' : ''}">${n(w.altitude.agl)}</td>
            <td>${n(w.waypointSpeed, 1)}</td>
            <td class="status-${w.altitude.status}">${STATUS_LABEL[w.altitude.status]}</td></tr>`,
        )
        .join('')}`;
    })
    .join('');
  const sel = findWp(state.selectedId);
  el.innerHTML = `
    ${sel ? `<div class="detail">${wpDetailHtml(sel)}</div>` : '<p class="muted">行または地図上のウェイポイントをクリックすると詳細を表示します。</p>'}
    <table class="grid" style="margin-top:10px">
      <tr><th>WP</th><th>ファイル値</th><th>対地 m</th><th>m/s</th><th>状態</th></tr>
      ${rows}
    </table>`;
}

function renderVerifyTab() {
  const el = $('#tab-verify');
  const offsetProp = state.anchor === 'ground' ? 'heightAGL' : 'heightAbs';
  const snippet = JSON.stringify(
    {
      type: 'symbol',
      layout: {
        'icon-image': '…',
        'symbol-height-offset': ['get', offsetProp],
        'symbol-height-anchor': state.anchor,
        'icon-allow-overlap': state.overlap,
      },
    },
    null,
    2,
  );
  const cmp = state.terrainCompare;
  const table = state.mission
    ? `<table class="grid">
        <tr><th>WP</th><th>DEM</th><th>query*</th><th>差</th><th>対地</th><th>標高</th></tr>
        ${state.resolved
          .map((w) => {
            const q = cmp?.get(w.id) ?? null;
            const d = q !== null && w.groundElevation !== null ? q - w.groundElevation : null;
            return `<tr class="clickable ${w.id === state.selectedId ? 'selected' : ''}" data-wp="${w.id}">
              <td>${w.waylineId}-${w.index}</td><td>${n(w.groundElevation)}</td><td>${cmp ? n(q) : ''}</td>
              <td>${d === null ? '' : (d >= 0 ? '+' : '') + d.toFixed(1)}</td>
              <td class="${w.altitude.belowGround ? 'below' : ''}">${n(w.altitude.agl)}</td><td>${n(w.altitude.absolute)}</td></tr>`;
          })
          .join('')}
      </table>
      <p class="muted">DEM: 地理院標高タイル z14 を双線形補間した値（高度換算に使用）。query*: 描画中の Terrain から <code>map.queryTerrainElevation()</code> で得た値 ÷ 誇張率。単位 m。</p>`
    : '<p class="muted">KMZ を読み込むと比較表が表示されます。</p>';

  el.innerHTML = `
    <h3>symbol-height-anchor</h3>
    <div class="form-row">
      <label><input type="radio" name="anchor" value="ground" ${state.anchor === 'ground' ? 'checked' : ''}/> ground</label>
      <span class="muted">地表から heightAGL [m] 上に置く</span>
    </div>
    <div class="form-row">
      <label><input type="radio" name="anchor" value="absolute" ${state.anchor === 'absolute' ? 'checked' : ''}/> absolute</label>
      <span class="muted">海面（標高 0）から heightAbs [m] 上に置く</span>
    </div>
    <pre class="code">${esc(snippet)}</pre>

    <h3>見え方の確認</h3>
    <div class="form-row">
      <label>カメラのピッチ</label>
      ${[0, 45, 60, 75, 85].map((p) => `<button class="btn small" data-pitch="${p}">${p}°</button>`).join('')}
    </div>
    <div class="form-row">
      <label for="exag">地形の誇張</label>
      <select id="exag">${[1, 1.5, 2, 3].map((v) => `<option value="${v}" ${v === state.exaggeration ? 'selected' : ''}>×${v}</option>`).join('')}</select>
    </div>
    <div class="form-row">
      <label>シンボル</label>
      <label class="check" style="box-shadow:none;padding:0"><input type="checkbox" id="overlap" ${state.overlap ? 'checked' : ''}/> 重なりを許可</label>
      <label class="check" style="box-shadow:none;padding:0"><input type="checkbox" id="height-labels" ${state.heightLabels ? 'checked' : ''}/> 高さラベル</label>
    </div>
    <div class="notice info">
      <ul>
        <li>ground は Terrain 有効時に「描画中の地形の高さ + offset」、無効時は「0 + offset」に置かれます。</li>
        <li>absolute は地形を無視して標高そのものに置くため、Terrain 無効時は地図面から標高分だけ浮きます。</li>
        <li>地形を誇張すると、地形の高さは誇張されますが offset は誇張されません。absolute の点は地形に埋もれ、ground の点は地表との間隔を保ちます。</li>
        <li>重なりを許可しない場合、衝突判定は画面上の位置で行われるため、高さの異なる点どうしでも画面で重なれば片方が非表示になります。</li>
      </ul>
    </div>

    <h3>DEM と描画中の地形の比較</h3>
    <div class="form-row">
      <button class="btn small" data-action="compare" ${state.mission ? '' : 'disabled'}>queryTerrainElevation と比較</button>
      ${state.terrain ? '' : '<span class="muted">（地形ありで実行してください）</span>'}
    </div>
    ${table}`;
}

function renderDebugTab() {
  const el = $('#tab-debug');
  const ms = state.mission;
  if (!ms) {
    el.innerHTML = '<p class="muted">KMZ を読み込むと解析結果を表示します。</p>';
    return;
  }
  const summary = {
    fileName: ms.fileName,
    source: ms.source,
    wpmlNamespace: ms.wpmlNamespace,
    missionConfig: ms.missionConfig,
    takeoffRef: ms.takeoffRef,
    templateFolders: ms.templateFolders.map((f) => ({ ...f, polygons: f.polygons.map((p) => `${p.length} 点`) })),
    waylines: ms.waylines.map((w) => ({ ...w, waypoints: `${w.waypoints.length} 件（先頭: ${JSON.stringify(w.waypoints[0] ?? null)}）` })),
  };
  el.innerHTML = `
    <h3>KMZ の中身</h3>
    <ul>${ms.files.map((f) => `<li><code>${esc(f)}</code></li>`).join('')}</ul>
    <h3>警告（${ms.warnings.length}）</h3>
    ${ms.warnings.length ? `<ul>${ms.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '<p class="muted">なし</p>'}
    <h3>解析結果</h3>
    <pre class="code">${esc(JSON.stringify(summary, null, 2))}</pre>
    <h3>変換結果（GeoJSON の properties 先頭 3 件）</h3>
    <pre class="code">${esc(
      JSON.stringify(
        waypointsToGeoJSON(state.resolved, waylineOrder()).features.slice(0, 3).map((f) => f.properties),
        null,
        2,
      ),
    )}</pre>`;
}

function activateTab(name: string) {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll<HTMLElement>('.tab-body').forEach((s) => s.classList.toggle('active', s.id === `tab-${name}`));
}

// ---------------------------------------------------------------- 再生

let lastFrame = 0;

function droneFeature(): FeatureCollection {
  const tl = state.timeline;
  if (!tl || tl.segments.length === 0) return { type: 'FeatureCollection', features: [] };
  const st = stateAt(tl, state.time)!;
  const ground = sampler.elevation(st.lng, st.lat);
  const agl = st.absolute !== null && ground !== null ? st.absolute - ground : st.agl;
  const abs = st.absolute ?? (ground ?? 0) + st.agl;
  const seg = tl.segments[st.segmentIndex];
  const bearing =
    (Math.atan2(
      (seg.to.lng - seg.from.lng) * Math.cos((st.lat * Math.PI) / 180),
      seg.to.lat - seg.from.lat,
    ) *
      180) /
    Math.PI;
  const f: Feature<Point> = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [st.lng, st.lat] },
    properties: { heightAGL: agl, heightAbs: abs, bearing },
  };
  return { type: 'FeatureCollection', features: [f] };
}

function updateDrone() {
  view.setDrone(state.mission ? droneFeature() : { type: 'FeatureCollection', features: [] });
}

function updatePlayerInfo() {
  const tl = state.timeline;
  const info = $('#player-info');
  if (!tl || tl.segments.length === 0) {
    info.textContent = '';
    return;
  }
  const st = stateAt(tl, state.time)!;
  const ground = sampler.elevation(st.lng, st.lat);
  const agl = st.absolute !== null && ground !== null ? st.absolute - ground : null;
  ($('#seek') as HTMLInputElement).value = String(Math.round((state.time / tl.totalTime) * 1000));
  info.innerHTML = `シミュレーション <b>${formatDuration(state.time)}</b> / ${formatDuration(tl.totalTime)}（推定）
    ｜ WP ${esc(st.fromLabel)} → ${esc(st.toLabel)}
    ｜ 対地 <b>${agl === null ? '—' : agl.toFixed(1) + ' m'}</b>
    ｜ 標高 ${st.absolute === null ? '—' : st.absolute.toFixed(1) + ' m'}
    ｜ ${st.speed} m/s${tl.segments[st.segmentIndex].speedAssumed ? '（仮）' : ''}
    ${tl.usesAssumedSpeed ? `<br>速度が記録されていない区間は ${DEFAULT_SPEED} m/s と仮定しています。` : ''}
    <br>WP 間を直線で結んだ推定です。加減速・旋回・撮影などの動作は含みません。`;
}

function frame(ts: number) {
  if (!state.playing || !state.timeline) return;
  const dt = lastFrame ? (ts - lastFrame) / 1000 : 0;
  lastFrame = ts;
  state.time += dt * state.playSpeed;
  if (state.time >= state.timeline.totalTime) {
    state.time = state.timeline.totalTime;
    stop();
  }
  updateDrone();
  updatePlayerInfo();
  if (state.playing) requestAnimationFrame(frame);
}

function play() {
  if (!state.timeline) return;
  if (state.time >= state.timeline.totalTime) state.time = 0;
  state.playing = true;
  lastFrame = 0;
  $('#play').textContent = '一時停止';
  requestAnimationFrame(frame);
}

function stop() {
  state.playing = false;
  $('#play').textContent = '再生';
}

// ---------------------------------------------------------------- イベント

let toastTimer = 0;
function toast(msg: string, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

$('#file-input').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) await loadKmz(await f.arrayBuffer(), f.name, null);
  (e.target as HTMLInputElement).value = '';
  ($('#sample-select') as HTMLSelectElement).value = '';
});

$('#sample-select').addEventListener('change', (e) => {
  const v = (e.target as HTMLSelectElement).value;
  if (v) loadSample(v);
});

// ドラッグ＆ドロップ（ウィンドウ全体）
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  $('#drop-overlay').hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('#drop-overlay').hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  if (!/\.(kmz|zip)$/i.test(f.name)) {
    toast('KMZ ファイルをドロップしてください');
    return;
  }
  ($('#sample-select') as HTMLSelectElement).value = '';
  await loadKmz(await f.arrayBuffer(), f.name, null);
});

document.querySelector('.tabs')!.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (b?.dataset.tab) {
    activateTab(b.dataset.tab);
    $('#panel').classList.remove('collapsed');
  }
});

$('#panel-toggle').addEventListener('click', () => {
  const p = $('#panel');
  p.classList.toggle('collapsed');
  $('#panel-toggle').setAttribute('aria-expanded', String(!p.classList.contains('collapsed')));
});

$('#panel').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const row = t.closest<HTMLElement>('tr[data-wp]');
  if (row) {
    selectWaypoint(row.dataset.wp!, true);
    return;
  }
  const pitch = t.closest<HTMLElement>('[data-pitch]');
  if (pitch) {
    view.setPitch(Number(pitch.dataset.pitch));
    return;
  }
  const action = t.closest<HTMLElement>('[data-action]')?.dataset.action;
  if (action === 'pick-takeoff') {
    state.pickingTakeoff = true;
    toast('地図上の離陸地点をクリックしてください');
    renderPlanTab();
  } else if (action === 'reset-takeoff') {
    state.userTakeoff = null;
    recompute();
  } else if (action === 'compare') {
    const cmp = new Map<string, number | null>();
    for (const w of state.resolved) {
      const q = view.queryTerrainElevation(w.lng, w.lat);
      cmp.set(w.id, q === null ? null : q / state.exaggeration);
    }
    state.terrainCompare = cmp;
    renderVerifyTab();
  }
});

$('#panel').addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === 'geoid') {
    const v = t.value.trim() === '' ? null : Number(t.value);
    state.geoidHeight = v !== null && Number.isFinite(v) ? v : null;
    recompute();
  } else if (t.name === 'anchor') {
    state.anchor = t.value as AnchorMode;
    view.setAnchor(state.anchor);
    refresh3d();
    renderVerifyTab();
  } else if (t.id === 'exag') {
    state.exaggeration = Number(t.value);
    view.setTerrain(state.terrain, state.exaggeration);
    state.terrainCompare = null;
    refresh3d();
    renderVerifyTab();
  } else if (t.id === 'overlap') {
    state.overlap = t.checked;
    view.setOverlap(t.checked);
    renderVerifyTab();
  } else if (t.id === 'height-labels') {
    state.heightLabels = t.checked;
    view.setHeightLabels(t.checked);
  }
});

document.querySelectorAll<HTMLElement>('.map-tools .seg').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    const v = b.dataset.value!;
    switch (seg.dataset.group) {
      case 'basemap':
        state.basemap = v as Basemap;
        view.setBasemap(state.basemap);
        break;
      case 'terrain':
        state.terrain = v === 'on';
        view.setTerrain(state.terrain, state.exaggeration);
        state.terrainCompare = null;
        refresh3d();
        renderVerifyTab();
        break;
      case 'route':
        state.routeMode = v as RouteMode;
        view.setRouteMode(state.routeMode, state.dropLines);
        break;
    }
  });
});

$('#drop-lines').addEventListener('change', (e) => {
  state.dropLines = (e.target as HTMLInputElement).checked;
  view.setRouteMode(state.routeMode, state.dropLines);
});

$('#play').addEventListener('click', () => (state.playing ? stop() : play()));
$('#seek').addEventListener('input', (e) => {
  if (!state.timeline) return;
  state.time = (Number((e.target as HTMLInputElement).value) / 1000) * state.timeline.totalTime;
  updateDrone();
  updatePlayerInfo();
});
$('#speed').addEventListener('change', (e) => (state.playSpeed = Number((e.target as HTMLSelectElement).value)));

// ---------------------------------------------------------------- 起動

const samplesPromise: Promise<SampleEntry[]> = fetch('./samples/index.json')
  .then((r) => (r.ok ? r.json() : []))
  .catch(() => []);

samplesPromise.then((list) => {
  const sel = $('#sample-select') as HTMLSelectElement;
  for (const s of list) {
    const o = document.createElement('option');
    o.value = s.file;
    o.textContent = s.title;
    sel.appendChild(o);
  }
  const q = new URLSearchParams(location.search).get('sample');
  if (q) {
    sel.value = q;
    loadSample(q);
  }
});

renderAll();

// 開発・検証用
(window as unknown as { __app: unknown }).__app = { state, view, sampler };
