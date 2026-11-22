import * as maplibregl from 'maplibre-gl';
import {
  type ExpressionSpecification,
  type GeoJSONSource,
  type LngLatBoundsLike,
  type Map as MlMap,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// v6 は Worker を別ファイル（ES モジュール）で読み込む。Vite の事前バンドルでは相対パスが解決できないため明示する
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { FeatureCollection } from 'geojson';
import { registerGsiDemProtocol } from '../terrain/browserDem';
import { GSI_DEM_MAX_ZOOM } from '../terrain/gsiDem';
import { addIcons } from './icons';
import { ThreeRouteLayer, type Route3D } from './threeRouteLayer';

export type AnchorMode = 'ground' | 'absolute';
export type Basemap = 'std' | 'photo';
export type RouteMode = '2d' | '3d' | 'both';

const GSI_ATTR =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>（標準地図・シームレス空中写真・標高タイル）';

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function style(): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      'gsi-std': {
        type: 'raster',
        tiles: ['https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 18,
        attribution: GSI_ATTR,
      },
      'gsi-photo': {
        type: 'raster',
        tiles: ['https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg'],
        tileSize: 256,
        maxzoom: 18,
        attribution: GSI_ATTR,
      },
      // Terrain 用と陰影用でソースを分ける（MapLibre の推奨）
      'gsi-dem': { type: 'raster-dem', tiles: ['gsidem://{z}/{x}/{y}'], tileSize: 256, maxzoom: GSI_DEM_MAX_ZOOM, encoding: 'terrarium' },
      'gsi-dem-hs': { type: 'raster-dem', tiles: ['gsidem://{z}/{x}/{y}'], tileSize: 256, maxzoom: GSI_DEM_MAX_ZOOM, encoding: 'terrarium' },
      mission: { type: 'geojson', data: EMPTY },
      routes: { type: 'geojson', data: EMPTY },
      area: { type: 'geojson', data: EMPTY },
      takeoff: { type: 'geojson', data: EMPTY },
      drone: { type: 'geojson', data: EMPTY },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#e9ecef' } },
      { id: 'basemap-std', type: 'raster', source: 'gsi-std' },
      { id: 'basemap-photo', type: 'raster', source: 'gsi-photo', layout: { visibility: 'none' } },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'gsi-dem-hs',
        paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#495057' },
      },
      {
        id: 'area-fill',
        type: 'fill',
        source: 'area',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#1c7ed6', 'fill-opacity': 0.15 },
      },
      { id: 'area-line', type: 'line', source: 'area', paint: { 'line-color': '#1c7ed6', 'line-width': 2, 'line-dasharray': [2, 1] } },
      {
        id: 'route-2d',
        type: 'line',
        source: 'routes',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.85 },
      },
      {
        id: 'wp-ground',
        type: 'circle',
        source: 'mission',
        paint: {
          'circle-radius': 3.5,
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
          'circle-pitch-alignment': 'map',
        },
      },
      {
        id: 'takeoff',
        type: 'symbol',
        source: 'takeoff',
        layout: {
          'icon-image': 'takeoff',
          'icon-allow-overlap': true,
          'text-field': ['get', 'label'],
          'text-font': ['Open Sans Semibold'],
          'text-size': 11,
          'text-offset': [0, 1.6],
          'text-anchor': 'top',
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#212529', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      },
    ],
  };
}

/** 空中ウェイポイントのレイヤー（このアプリの主題） */
function waypointLayers(anchor: AnchorMode, overlap: boolean): maplibregl.LayerSpecification[] {
  const offset: ExpressionSpecification = ['get', anchor === 'ground' ? 'heightAGL' : 'heightAbs'];
  return [
    {
      id: 'wp-symbol',
      type: 'symbol',
      source: 'mission',
      layout: {
        'icon-image': [
          'case',
          ['==', ['get', 'status'], 'unsupported'],
          'wp-unsupported',
          ['concat', 'wp-', ['to-string', ['get', 'colorIndex']], '-', ['get', 'status']],
        ],
        'symbol-height-offset': offset,
        'symbol-height-anchor': anchor,
        'icon-allow-overlap': overlap,
        'text-allow-overlap': overlap,
        'icon-ignore-placement': false,
        'symbol-sort-key': ['-', 0, ['get', 'heightAbs']],
        'text-field': ['get', 'label'],
        'text-font': ['Open Sans Semibold'],
        'text-size': 11,
      },
      paint: {
        'text-color': ['case', ['==', ['get', 'status'], 'reference'], '#212529', '#ffffff'],
      },
    },
    {
      id: 'wp-height-label',
      type: 'symbol',
      source: 'mission',
      layout: {
        visibility: 'none',
        'symbol-height-offset': offset,
        'symbol-height-anchor': anchor,
        'text-field': ['get', 'heightLabel'],
        'text-font': ['Open Sans Semibold'],
        'text-size': 11,
        'text-offset': [0, 1.3],
        'text-anchor': 'top',
        'text-allow-overlap': overlap,
      },
      paint: { 'text-color': '#212529', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
    },
    {
      id: 'wp-selected',
      type: 'symbol',
      source: 'mission',
      filter: ['==', ['get', 'id'], ''],
      layout: {
        'icon-image': 'wp-selected',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-height-offset': offset,
        'symbol-height-anchor': anchor,
      },
    },
    {
      id: 'drone',
      type: 'symbol',
      source: 'drone',
      layout: {
        'icon-image': 'drone',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'symbol-height-offset': offset,
        'symbol-height-anchor': anchor,
      },
    },
  ];
}

export interface MapViewOptions {
  container: HTMLElement;
  onWaypointClick: (id: string, lngLat: maplibregl.LngLat) => void;
  onMapClick: (lngLat: maplibregl.LngLat) => void;
}

export class MapView {
  readonly map: MlMap;
  readonly route3d = new ThreeRouteLayer();
  private ready: Promise<void>;
  anchor: AnchorMode = 'ground';
  overlap = true;
  terrain = true;
  exaggeration = 1;

  constructor(opts: MapViewOptions) {
    maplibregl.setWorkerUrl(workerUrl);
    registerGsiDemProtocol();
    this.map = new maplibregl.Map({
      container: opts.container,
      style: style(),
      center: [143.2, 42.92],
      zoom: 11,
      pitch: 60,
      bearing: -20,
      maxPitch: 85,
      attributionControl: { compact: true },
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    this.ready = new Promise((resolve) => {
      // 'load' は初回の全タイル読み込み完了まで待つため、レイヤー追加はスタイル読み込み完了時点で行う
      this.map.once('style.load', () => {
        addIcons(this.map);
        this.map.addLayer(this.route3d);
        for (const l of waypointLayers(this.anchor, this.overlap)) this.map.addLayer(l);
        this.applyTerrain();
        resolve();
      });
    });

    this.map.on('click', (e) => {
      const hits = this.map.queryRenderedFeatures(e.point, { layers: ['wp-symbol'] });
      if (hits.length > 0) opts.onWaypointClick(String(hits[0].properties.id), e.lngLat);
      else opts.onMapClick(e.lngLat);
    });
    this.map.on('mouseenter', 'wp-symbol', () => (this.map.getCanvas().style.cursor = 'pointer'));
    this.map.on('mouseleave', 'wp-symbol', () => (this.map.getCanvas().style.cursor = ''));
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  private source(id: string): GeoJSONSource {
    return this.map.getSource(id) as GeoJSONSource;
  }

  setMissionData(data: {
    waypoints: FeatureCollection;
    routes: FeatureCollection;
    area: FeatureCollection;
    takeoff: FeatureCollection;
    routes3d: Route3D[];
  }): void {
    this.source('mission').setData(data.waypoints);
    this.source('routes').setData(data.routes);
    this.source('area').setData(data.area);
    this.source('takeoff').setData(data.takeoff);
    this.route3d.setRoutes(data.routes3d);
  }

  setDrone(fc: FeatureCollection): void {
    this.source('drone').setData(fc);
  }

  /** symbol-height-anchor と、参照する属性（heightAGL / heightAbs）を切り替える */
  setAnchor(anchor: AnchorMode): void {
    this.anchor = anchor;
    const offset: ExpressionSpecification = ['get', anchor === 'ground' ? 'heightAGL' : 'heightAbs'];
    for (const id of ['wp-symbol', 'wp-height-label', 'wp-selected', 'drone']) {
      this.map.setLayoutProperty(id, 'symbol-height-anchor', anchor);
      this.map.setLayoutProperty(id, 'symbol-height-offset', offset);
    }
  }

  setOverlap(v: boolean): void {
    this.overlap = v;
    this.map.setLayoutProperty('wp-symbol', 'icon-allow-overlap', v);
    this.map.setLayoutProperty('wp-symbol', 'text-allow-overlap', v);
    this.map.setLayoutProperty('wp-height-label', 'text-allow-overlap', v);
  }

  setHeightLabels(v: boolean): void {
    this.map.setLayoutProperty('wp-height-label', 'visibility', v ? 'visible' : 'none');
  }

  setSelected(id: string | null): void {
    this.map.setFilter('wp-selected', ['==', ['get', 'id'], id ?? '']);
  }

  setBasemap(b: Basemap): void {
    this.map.setLayoutProperty('basemap-std', 'visibility', b === 'std' ? 'visible' : 'none');
    this.map.setLayoutProperty('basemap-photo', 'visibility', b === 'photo' ? 'visible' : 'none');
    this.map.setPaintProperty('hillshade', 'hillshade-exaggeration', b === 'std' ? 0.35 : 0.15);
  }

  setRouteMode(mode: RouteMode, dropLines: boolean): void {
    this.map.setLayoutProperty('route-2d', 'visibility', mode === '3d' ? 'none' : 'visible');
    this.route3d.setVisibility(mode !== '2d', dropLines);
  }

  setTerrain(on: boolean, exaggeration = this.exaggeration): void {
    this.terrain = on;
    this.exaggeration = exaggeration;
    this.applyTerrain();
  }

  private applyTerrain(): void {
    this.map.setTerrain(this.terrain ? { source: 'gsi-dem', exaggeration: this.exaggeration } : null);
  }

  /** 描画中の Terrain から標高を得る（検証用）。Terrain 無効時は null。 */
  queryTerrainElevation(lng: number, lat: number): number | null {
    return this.map.queryTerrainElevation([lng, lat]);
  }

  fitTo(bounds: [number, number, number, number]): void {
    const isNarrow = window.innerWidth < 760;
    const padding = isNarrow
      ? { top: 80, bottom: Math.round(window.innerHeight * 0.45), left: 30, right: 30 }
      : { top: 90, bottom: 130, left: 420, right: 80 };
    const [w, s, e, n] = bounds;
    const pad = Math.max(e - w, n - s) * 0.1 + 0.0005;
    this.map.fitBounds(
      [
        [w - pad, s - pad],
        [e + pad, n + pad],
      ] as LngLatBoundsLike,
      { padding, pitch: 60, bearing: -20, duration: 1200, maxZoom: 17 },
    );
  }

  flyToPoint(lng: number, lat: number): void {
    this.map.easeTo({ center: [lng, lat], duration: 600 });
  }

  setPitch(p: number): void {
    this.map.easeTo({ pitch: p, duration: 600 });
  }
}
