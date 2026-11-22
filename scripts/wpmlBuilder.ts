/**
 * DJI WPML 仕様（Cloud API v1.x, DJI WPML）に沿ったテスト用 KMZ を組み立てる。
 * 実機ファイルにあるアクション（撮影等）は高度検証に関係しないため最小限にしている。
 */
import JSZip from 'jszip';

export const NS_KML = 'http://www.opengis.net/kml/2.2';
export const NS_WPML = 'http://www.dji.com/wpmz/1.0.6';

/** Mavic 3M（M3M）: droneEnumValue=77, droneSubEnumValue=2, payloadEnumValue=68（実機 KMZ で要確認） */
export const MAVIC3M = { drone: 77, droneSub: 2, payload: 68 };

export interface SampleWaypoint {
  lng: number;
  lat: number;
  height: number;
  speed?: number;
}

export interface SampleWayline {
  waylineId: number;
  heightMode: string;
  autoFlightSpeed: number;
  waypoints: SampleWaypoint[];
}

export interface SampleMission {
  author?: string;
  takeOffRefPoint?: { lat: number; lng: number; ellipsoidHeight: number };
  takeOffSecurityHeight?: number;
  waylines: SampleWayline[];
  /** template.kml の heightMode（waylines と別に指定する場合） */
  templateHeightMode?: string;
  /** template.kml のウェイポイントの楕円体高（WGS84 / EGM96 ケース用）。省略時は height と同値 */
  templateEllipsoid?: (wp: SampleWaypoint) => number;
  /** waylines.wpml を含めない（template.kml のみの KMZ） */
  omitWaylines?: boolean;
  /** 測量エリア（mapping2d テンプレート）。指定するとウェイポイントテンプレートの代わりに出力 */
  mappingPolygon?: Array<[number, number]>;
}

const f = (v: number, d = 7) => Number(v.toFixed(d)).toString();

function missionConfigXml(m: SampleMission, forTemplate: boolean): string {
  const t = m.takeOffRefPoint;
  return `    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
      <wpml:takeOffSecurityHeight>${m.takeOffSecurityHeight ?? 20}</wpml:takeOffSecurityHeight>
${
  forTemplate && t
    ? `      <wpml:takeOffRefPoint>${f(t.lat)},${f(t.lng)},${f(t.ellipsoidHeight, 3)}</wpml:takeOffRefPoint>
      <wpml:takeOffRefPointAGLHeight>0</wpml:takeOffRefPointAGLHeight>
`
    : ''
}      <wpml:globalTransitionalSpeed>10</wpml:globalTransitionalSpeed>
      <wpml:globalRTHHeight>100</wpml:globalRTHHeight>
      <wpml:droneInfo>
        <wpml:droneEnumValue>${MAVIC3M.drone}</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>${MAVIC3M.droneSub}</wpml:droneSubEnumValue>
      </wpml:droneInfo>
      <wpml:payloadInfo>
        <wpml:payloadEnumValue>${MAVIC3M.payload}</wpml:payloadEnumValue>
        <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
      </wpml:payloadInfo>
    </wpml:missionConfig>`;
}

export function buildTemplateKml(m: SampleMission): string {
  const now = Date.UTC(2026, 10, 1);
  const folders = m.mappingPolygon
    ? [
        `    <Folder>
      <wpml:templateType>mapping2d</wpml:templateType>
      <wpml:templateId>0</wpml:templateId>
      <wpml:waylineCoordinateSysParam>
        <wpml:coordinateMode>WGS84</wpml:coordinateMode>
        <wpml:heightMode>${m.templateHeightMode ?? 'relativeToStartPoint'}</wpml:heightMode>
        <wpml:globalShootHeight>60</wpml:globalShootHeight>
        <wpml:surfaceFollowModeEnable>0</wpml:surfaceFollowModeEnable>
      </wpml:waylineCoordinateSysParam>
      <wpml:autoFlightSpeed>8</wpml:autoFlightSpeed>
      <Placemark>
        <Polygon>
          <outerBoundaryIs>
            <LinearRing>
              <coordinates>
                ${m.mappingPolygon.map(([x, y]) => `${f(x)},${f(y)},0`).join('\n                ')}
              </coordinates>
            </LinearRing>
          </outerBoundaryIs>
        </Polygon>
        <wpml:ellipsoidHeight>60</wpml:ellipsoidHeight>
        <wpml:height>60</wpml:height>
      </Placemark>
    </Folder>`,
      ]
    : m.waylines.map(
        (wl) => `    <Folder>
      <wpml:templateType>waypoint</wpml:templateType>
      <wpml:templateId>${wl.waylineId}</wpml:templateId>
      <wpml:waylineCoordinateSysParam>
        <wpml:coordinateMode>WGS84</wpml:coordinateMode>
        <wpml:heightMode>${m.templateHeightMode ?? wl.heightMode}</wpml:heightMode>
      </wpml:waylineCoordinateSysParam>
      <wpml:autoFlightSpeed>${wl.autoFlightSpeed}</wpml:autoFlightSpeed>
      <wpml:globalHeight>${wl.waypoints[0]?.height ?? 0}</wpml:globalHeight>
      <wpml:caliFlightEnable>0</wpml:caliFlightEnable>
      <wpml:gimbalPitchMode>usePointSetting</wpml:gimbalPitchMode>
      <wpml:globalWaypointHeadingParam>
        <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>
      </wpml:globalWaypointHeadingParam>
      <wpml:globalWaypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:globalWaypointTurnMode>
      <wpml:globalUseStraightLine>1</wpml:globalUseStraightLine>
${wl.waypoints
  .map(
    (wp, i) => `      <Placemark>
        <Point>
          <coordinates>
            ${f(wp.lng)},${f(wp.lat)}
          </coordinates>
        </Point>
        <wpml:index>${i}</wpml:index>
        <wpml:ellipsoidHeight>${f(m.templateEllipsoid ? m.templateEllipsoid(wp) : wp.height, 3)}</wpml:ellipsoidHeight>
        <wpml:height>${f(wp.height, 3)}</wpml:height>
        <wpml:useGlobalHeight>0</wpml:useGlobalHeight>
        <wpml:useGlobalSpeed>${wp.speed === undefined ? 1 : 0}</wpml:useGlobalSpeed>${
          wp.speed === undefined ? '' : `\n        <wpml:waypointSpeed>${wp.speed}</wpml:waypointSpeed>`
        }
        <wpml:useGlobalHeadingParam>1</wpml:useGlobalHeadingParam>
        <wpml:useGlobalTurnParam>1</wpml:useGlobalTurnParam>
        <wpml:useStraightLine>1</wpml:useStraightLine>
      </Placemark>`,
  )
  .join('\n')}
    </Folder>`,
      );

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="${NS_KML}" xmlns:wpml="${NS_WPML}">
  <Document>
    <wpml:author>${m.author ?? 'sample'}</wpml:author>
    <wpml:createTime>${now}</wpml:createTime>
    <wpml:updateTime>${now}</wpml:updateTime>
${missionConfigXml(m, true)}
${folders.join('\n')}
  </Document>
</kml>
`;
}

export function buildWaylinesWpml(m: SampleMission): string {
  const folders = m.waylines.map(
    (wl) => `    <Folder>
      <wpml:templateId>${wl.waylineId}</wpml:templateId>
      <wpml:executeHeightMode>${wl.heightMode}</wpml:executeHeightMode>
      <wpml:waylineId>${wl.waylineId}</wpml:waylineId>
      <wpml:distance>0</wpml:distance>
      <wpml:duration>0</wpml:duration>
      <wpml:autoFlightSpeed>${wl.autoFlightSpeed}</wpml:autoFlightSpeed>
${wl.waypoints
  .map(
    (wp, i) => `      <Placemark>
        <Point>
          <coordinates>
            ${f(wp.lng)},${f(wp.lat)}
          </coordinates>
        </Point>
        <wpml:index>${i}</wpml:index>
        <wpml:executeHeight>${f(wp.height, 3)}</wpml:executeHeight>
        <wpml:waypointSpeed>${wp.speed ?? wl.autoFlightSpeed}</wpml:waypointSpeed>
        <wpml:waypointHeadingParam>
          <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>
        </wpml:waypointHeadingParam>
        <wpml:waypointTurnParam>
          <wpml:waypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:waypointTurnMode>
          <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>
        </wpml:waypointTurnParam>
        <wpml:useStraightLine>1</wpml:useStraightLine>${
          i === 0
            ? `
        <wpml:actionGroup>
          <wpml:actionGroupId>0</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>0</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>0</wpml:actionGroupEndIndex>
          <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
          <wpml:actionTrigger>
            <wpml:actionTriggerType>reachPoint</wpml:actionTriggerType>
          </wpml:actionTrigger>
          <wpml:action>
            <wpml:actionId>0</wpml:actionId>
            <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>
        </wpml:actionGroup>`
            : ''
        }
      </Placemark>`,
  )
  .join('\n')}
    </Folder>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="${NS_KML}" xmlns:wpml="${NS_WPML}">
  <Document>
${missionConfigXml(m, false)}
${folders.join('\n')}
  </Document>
</kml>
`;
}

export async function buildKmz(m: SampleMission): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('wpmz/template.kml', buildTemplateKml(m));
  if (!m.omitWaylines) zip.file('wpmz/waylines.wpml', buildWaylinesWpml(m));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
