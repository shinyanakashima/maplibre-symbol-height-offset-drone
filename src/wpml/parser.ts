import JSZip from 'jszip';
import type {
  MissionConfig,
  ParsedMission,
  TakeoffRef,
  TemplateFolderInfo,
  WaylineRecord,
  WaypointRecord,
} from './types';

/**
 * DJI WPML（KMZ）パーサー。
 *
 * - KML 要素は http://www.opengis.net/kml/2.2、WPML 拡張要素は http://www.dji.com/wpmz/1.0.x の名前空間。
 *   名前空間 URI のバージョンは機体・ソフトによって異なるため、要素は「直下の子要素のローカル名」で探す。
 * - wpmz/waylines.wpml（実行ファイル）を優先し、なければ wpmz/template.kml（テンプレートファイル）から取れる範囲で読む。
 */

const WPML_NS_PREFIX = 'http://www.dji.com/wpmz/';

/** 直下の子要素をローカル名で取得 */
function child(el: Element | null | undefined, localName: string): Element | null {
  if (!el) return null;
  for (const c of Array.from(el.children)) {
    if (c.localName === localName) return c;
  }
  return null;
}

function children(el: Element | null | undefined, localName: string): Element[] {
  if (!el) return [];
  return Array.from(el.children).filter((c) => c.localName === localName);
}

function text(el: Element | null | undefined, localName: string): string | null {
  const c = child(el, localName);
  const t = c?.textContent?.trim();
  return t ? t : null;
}

function num(el: Element | null | undefined, localName: string): number | null {
  const t = text(el, localName);
  if (t === null) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

function bool(el: Element | null | undefined, localName: string): boolean | null {
  const t = text(el, localName);
  if (t === null) return null;
  return t === '1' || t.toLowerCase() === 'true';
}

/** KML の coordinates（"経度,緯度[,高さ]" を空白区切りで列挙）を読む */
export function parseCoordinates(s: string): Array<[number, number, number | null]> {
  return s
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tuple) => {
      const [lng, lat, alt] = tuple.split(',').map((v) => Number(v));
      return [lng, lat, alt === undefined || Number.isNaN(alt) ? null : alt] as [number, number, number | null];
    })
    .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
}

function parseXml(xml: string, name: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error(`${name} の XML 解析に失敗しました: ${err.textContent?.slice(0, 200)}`);
  return doc;
}

function documentElementOf(doc: Document): Element | null {
  return child(doc.documentElement, 'Document');
}

function findWpmlNamespace(doc: Document): string | null {
  const root = doc.documentElement;
  for (const attr of Array.from(root.attributes)) {
    if (attr.value.startsWith(WPML_NS_PREFIX)) return attr.value;
  }
  return null;
}

function parseMissionConfig(docEl: Element | null): MissionConfig {
  const mc = child(docEl, 'missionConfig');
  const drone = child(mc, 'droneInfo');
  const payload = child(mc, 'payloadInfo');
  return {
    flyToWaylineMode: text(mc, 'flyToWaylineMode'),
    finishAction: text(mc, 'finishAction'),
    takeOffSecurityHeight: num(mc, 'takeOffSecurityHeight'),
    globalTransitionalSpeed: num(mc, 'globalTransitionalSpeed'),
    globalRTHHeight: num(mc, 'globalRTHHeight'),
    droneEnumValue: num(drone, 'droneEnumValue'),
    droneSubEnumValue: num(drone, 'droneSubEnumValue'),
    payloadEnumValue: num(payload, 'payloadEnumValue'),
  };
}

/** wpml:takeOffRefPoint は「緯度,経度,楕円体高」の順（KML の coordinates と逆）であることに注意 */
export function parseTakeoffRef(docEl: Element | null): TakeoffRef | null {
  const mc = child(docEl, 'missionConfig');
  const t = text(mc, 'takeOffRefPoint');
  if (!t) return null;
  const [lat, lng, h] = t.split(',').map((v) => Number(v.trim()));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    ellipsoidHeight: Number.isFinite(h) ? h : null,
    aglHeight: num(mc, 'takeOffRefPointAGLHeight'),
  };
}

export interface WaylinesParseResult {
  wpmlNamespace: string | null;
  missionConfig: MissionConfig;
  waylines: WaylineRecord[];
  warnings: string[];
}

/** waylines.wpml（実行ファイル）を解析 */
export function parseWaylinesWpml(xml: string): WaylinesParseResult {
  const doc = parseXml(xml, 'waylines.wpml');
  const docEl = documentElementOf(doc);
  const warnings: string[] = [];
  if (!docEl) warnings.push('waylines.wpml に Document 要素がありません');

  const folders = children(docEl, 'Folder');
  const waylines: WaylineRecord[] = folders.map((folder, fi) => {
    const waylineIdRaw = num(folder, 'waylineId');
    const waylineId = waylineIdRaw ?? fi;
    if (waylineIdRaw === null) warnings.push(`Folder ${fi}: wpml:waylineId がないため ${fi} を仮に割り当てました`);
    const heightMode = text(folder, 'executeHeightMode');
    if (!heightMode) warnings.push(`wayline ${waylineId}: wpml:executeHeightMode がありません（高度は変換しません）`);
    const autoFlightSpeed = num(folder, 'autoFlightSpeed');

    const waypoints: WaypointRecord[] = [];
    children(folder, 'Placemark').forEach((pm, pi) => {
      const coordText = text(child(pm, 'Point'), 'coordinates');
      const coords = coordText ? parseCoordinates(coordText) : [];
      if (coords.length === 0) {
        warnings.push(`wayline ${waylineId} Placemark ${pi}: 座標がないためスキップしました`);
        return;
      }
      const [lng, lat] = coords[0];
      const indexRaw = num(pm, 'index');
      if (indexRaw === null) warnings.push(`wayline ${waylineId} Placemark ${pi}: wpml:index がないため出現順を使います`);
      const executeHeight = num(pm, 'executeHeight');
      if (executeHeight === null) warnings.push(`wayline ${waylineId} WP ${indexRaw ?? pi}: wpml:executeHeight がありません`);
      const wpSpeed = num(pm, 'waypointSpeed');
      waypoints.push({
        waylineId,
        index: indexRaw ?? pi,
        lng,
        lat,
        executeHeight,
        heightMode,
        ellipsoidHeight: null,
        waypointSpeed: wpSpeed ?? autoFlightSpeed,
        speedSource: wpSpeed !== null ? 'waypoint' : autoFlightSpeed !== null ? 'wayline' : 'none',
        source: 'waylines.wpml',
      });
    });
    waypoints.sort((a, b) => a.index - b.index);
    return {
      waylineId,
      templateId: num(folder, 'templateId'),
      heightMode,
      autoFlightSpeed,
      templateType: null,
      waypoints,
    };
  });

  return {
    wpmlNamespace: findWpmlNamespace(doc),
    missionConfig: parseMissionConfig(docEl),
    waylines,
    warnings,
  };
}

export interface TemplateParseResult {
  wpmlNamespace: string | null;
  missionConfig: MissionConfig;
  takeoffRef: TakeoffRef | null;
  folders: TemplateFolderInfo[];
  /** テンプレートに直接書かれたウェイポイント（waypoint テンプレートのみ） */
  waylines: WaylineRecord[];
  warnings: string[];
}

/** template.kml（テンプレートファイル）を解析 */
export function parseTemplateKml(xml: string): TemplateParseResult {
  const doc = parseXml(xml, 'template.kml');
  const docEl = documentElementOf(doc);
  const warnings: string[] = [];
  const folders: TemplateFolderInfo[] = [];
  const waylines: WaylineRecord[] = [];

  children(docEl, 'Folder').forEach((folder, fi) => {
    const csp = child(folder, 'waylineCoordinateSysParam');
    const templateId = num(folder, 'templateId');
    const templateType = text(folder, 'templateType');
    const heightMode = text(csp, 'heightMode');
    const globalHeight = num(folder, 'globalHeight');
    const autoFlightSpeed = num(folder, 'autoFlightSpeed');
    const polygons: Array<Array<[number, number]>> = [];

    const waypoints: WaypointRecord[] = [];
    children(folder, 'Placemark').forEach((pm, pi) => {
      // 測量テンプレート（mapping2d 等）はエリアのポリゴンのみを持つ
      const polygon = child(pm, 'Polygon');
      if (polygon) {
        const ringText = text(child(child(polygon, 'outerBoundaryIs'), 'LinearRing'), 'coordinates');
        if (ringText) polygons.push(parseCoordinates(ringText).map(([x, y]) => [x, y] as [number, number]));
        return;
      }
      const lineString = child(pm, 'LineString');
      if (lineString) {
        const lt = text(lineString, 'coordinates');
        if (lt) polygons.push(parseCoordinates(lt).map(([x, y]) => [x, y] as [number, number]));
        return;
      }
      const coordText = text(child(pm, 'Point'), 'coordinates');
      if (!coordText) return;
      const coords = parseCoordinates(coordText);
      if (coords.length === 0) return;
      const [lng, lat] = coords[0];
      const index = num(pm, 'index') ?? pi;
      const useGlobalHeight = bool(pm, 'useGlobalHeight');
      const useGlobalSpeed = bool(pm, 'useGlobalSpeed');
      const h = useGlobalHeight ? globalHeight : num(pm, 'height');
      const wpSpeed = useGlobalSpeed ? null : num(pm, 'waypointSpeed');
      waypoints.push({
        waylineId: templateId ?? fi,
        index,
        lng,
        lat,
        executeHeight: h,
        heightMode,
        ellipsoidHeight: useGlobalHeight ? null : num(pm, 'ellipsoidHeight'),
        waypointSpeed: wpSpeed ?? autoFlightSpeed,
        speedSource: wpSpeed !== null ? 'waypoint' : autoFlightSpeed !== null ? 'wayline' : 'none',
        source: 'template.kml',
      });
    });
    waypoints.sort((a, b) => a.index - b.index);

    folders.push({
      templateId,
      templateType,
      coordinateMode: text(csp, 'coordinateMode'),
      heightMode,
      globalHeight,
      globalShootHeight: num(csp, 'globalShootHeight'),
      surfaceFollowModeEnable: bool(csp, 'surfaceFollowModeEnable'),
      surfaceRelativeHeight: num(csp, 'surfaceRelativeHeight'),
      autoFlightSpeed,
      polygons,
    });

    if (waypoints.length > 0) {
      waylines.push({
        waylineId: templateId ?? fi,
        templateId,
        heightMode,
        autoFlightSpeed,
        templateType,
        waypoints,
      });
    } else if (templateType && templateType !== 'waypoint') {
      warnings.push(
        `template ${templateId ?? fi}（${templateType}）は経路が DJI Pilot 2 等で生成されるため、template.kml だけではウェイポイントを再現できません`,
      );
    }
  });

  return {
    wpmlNamespace: findWpmlNamespace(doc),
    missionConfig: parseMissionConfig(docEl),
    takeoffRef: parseTakeoffRef(docEl),
    folders,
    waylines,
    warnings,
  };
}

function findFile(zip: JSZip, name: string): JSZip.JSZipObject | null {
  const re = new RegExp(`(^|/)${name.replace('.', '\\.')}$`, 'i');
  const hit = Object.values(zip.files).find((f) => !f.dir && re.test(f.name));
  return hit ?? null;
}

/** KMZ（ZIP）を読み込んで解析する。すべてブラウザ内で処理する。 */
export async function parseKmz(data: ArrayBuffer | Uint8Array, fileName = 'mission.kmz'): Promise<ParsedMission> {
  const zip = await JSZip.loadAsync(data);
  const files = Object.values(zip.files)
    .filter((f) => !f.dir)
    .map((f) => f.name);
  const warnings: string[] = [];

  const waylinesFile = findFile(zip, 'waylines.wpml');
  const templateFile = findFile(zip, 'template.kml');
  if (waylinesFile && !/^wpmz\//i.test(waylinesFile.name)) {
    warnings.push(`waylines.wpml が標準の wpmz/ 以外の場所にあります: ${waylinesFile.name}`);
  }

  let template: TemplateParseResult | null = null;
  if (templateFile) {
    try {
      template = parseTemplateKml(await templateFile.async('string'));
    } catch (e) {
      warnings.push(String((e as Error).message));
    }
  }

  const emptyConfig = parseMissionConfig(null);

  if (waylinesFile) {
    const w = parseWaylinesWpml(await waylinesFile.async('string'));
    return {
      fileName,
      source: 'waylines.wpml',
      files,
      wpmlNamespace: w.wpmlNamespace ?? template?.wpmlNamespace ?? null,
      missionConfig: w.missionConfig,
      takeoffRef: template?.takeoffRef ?? null,
      waylines: w.waylines,
      templateFolders: template?.folders ?? [],
      warnings: [...warnings, ...w.warnings],
    };
  }

  if (template) {
    warnings.push('waylines.wpml がないため template.kml から取得できる範囲で表示しています');
    return {
      fileName,
      source: template.waylines.length > 0 ? 'template.kml' : null,
      files,
      wpmlNamespace: template.wpmlNamespace,
      missionConfig: template.missionConfig,
      takeoffRef: template.takeoffRef,
      waylines: template.waylines,
      templateFolders: template.folders,
      warnings: [...warnings, ...template.warnings],
    };
  }

  return {
    fileName,
    source: null,
    files,
    wpmlNamespace: null,
    missionConfig: emptyConfig,
    takeoffRef: null,
    waylines: [],
    templateFolders: [],
    warnings: [...warnings, 'KMZ 内に waylines.wpml も template.kml も見つかりません'],
  };
}
