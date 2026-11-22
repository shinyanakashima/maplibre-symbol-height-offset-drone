import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { parseCoordinates, parseKmz, parseTemplateKml, parseWaylinesWpml } from '../src/wpml/parser';
import { buildKmz, buildTemplateKml, buildWaylinesWpml, type SampleMission } from '../scripts/wpmlBuilder';

const mission: SampleMission = {
  takeOffRefPoint: { lat: 42.88, lng: 143.1, ellipsoidHeight: 117.5 },
  waylines: [
    {
      waylineId: 0,
      heightMode: 'relativeToStartPoint',
      autoFlightSpeed: 8,
      waypoints: [
        { lng: 143.1, lat: 42.88, height: 60 },
        { lng: 143.101, lat: 42.8805, height: 80, speed: 5 },
      ],
    },
    {
      waylineId: 1,
      heightMode: 'WGS84',
      autoFlightSpeed: 6,
      waypoints: [
        { lng: 143.102, lat: 42.881, height: 150.25 },
        { lng: 143.103, lat: 42.8815, height: 170 },
        { lng: 143.104, lat: 42.882, height: 190 },
      ],
    },
  ],
};

describe('parseCoordinates', () => {
  it('改行・空白を含む "経度,緯度" を読む', () => {
    expect(parseCoordinates('\n   143.1,42.88\n  ')).toEqual([[143.1, 42.88, null]]);
    expect(parseCoordinates('1,2,3 4,5,6')).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });
});

describe('parseWaylinesWpml', () => {
  const r = parseWaylinesWpml(buildWaylinesWpml(mission));

  it('wpml 名前空間を検出する', () => {
    expect(r.wpmlNamespace).toBe('http://www.dji.com/wpmz/1.0.6');
  });

  it('複数 wayline と各ウェイポイントの属性を取り出す', () => {
    expect(r.waylines.map((w) => w.waylineId)).toEqual([0, 1]);
    expect(r.waylines[0].heightMode).toBe('relativeToStartPoint');
    expect(r.waylines[1].heightMode).toBe('WGS84');
    const wp = r.waylines[0].waypoints[1];
    expect(wp).toMatchObject({ index: 1, lng: 143.101, lat: 42.8805, executeHeight: 80, waypointSpeed: 5, waylineId: 0 });
    expect(r.waylines[1].waypoints).toHaveLength(3);
    expect(r.waylines[1].waypoints[0].executeHeight).toBeCloseTo(150.25);
  });

  it('機体情報（Mavic 3M）を読む', () => {
    expect(r.missionConfig.droneEnumValue).toBe(77);
    expect(r.missionConfig.droneSubEnumValue).toBe(2);
    expect(r.missionConfig.takeOffSecurityHeight).toBe(20);
  });

  it('アクション内の要素をウェイポイント属性と取り違えない', () => {
    // actionGroup 内にも index に似た要素（actionGroupStartIndex 等）があるが直下の子要素だけを見る
    expect(r.waylines[0].waypoints.map((w) => w.index)).toEqual([0, 1]);
    expect(r.warnings).toEqual([]);
  });

  it('名前空間のバージョンや接頭辞が異なっても読める', () => {
    const xml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:w="http://www.dji.com/wpmz/1.0.2"><Document>
<Folder><w:waylineId>3</w:waylineId><w:executeHeightMode>WGS84</w:executeHeightMode><w:autoFlightSpeed>4</w:autoFlightSpeed>
<Placemark><Point><coordinates>140.1,35.2</coordinates></Point><w:index>0</w:index><w:executeHeight>99.5</w:executeHeight></Placemark>
</Folder></Document></kml>`;
    const p = parseWaylinesWpml(xml);
    expect(p.wpmlNamespace).toBe('http://www.dji.com/wpmz/1.0.2');
    expect(p.waylines[0].waypoints[0]).toMatchObject({
      waylineId: 3, lng: 140.1, lat: 35.2, executeHeight: 99.5, waypointSpeed: 4, speedSource: 'wayline',
    });
  });

  it('高度モードがない場合は警告を出し、値は推測しない', () => {
    const xml = `<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.6"><Document><Folder>
<wpml:waylineId>0</wpml:waylineId>
<Placemark><Point><coordinates>140,35</coordinates></Point><wpml:index>0</wpml:index><wpml:executeHeight>50</wpml:executeHeight></Placemark>
</Folder></Document></kml>`;
    const p = parseWaylinesWpml(xml);
    expect(p.waylines[0].heightMode).toBeNull();
    expect(p.warnings.join()).toContain('executeHeightMode');
    expect(p.waylines[0].waypoints[0].speedSource).toBe('none');
  });

  it('不正な XML はエラーにする', () => {
    expect(() => parseWaylinesWpml('<kml><Document>')).toThrow();
  });
});

describe('parseTemplateKml', () => {
  it('takeOffRefPoint は 緯度,経度,楕円体高 の順で読む', () => {
    const t = parseTemplateKml(buildTemplateKml(mission));
    expect(t.takeoffRef).toEqual({ lat: 42.88, lng: 143.1, ellipsoidHeight: 117.5, aglHeight: 0 });
  });

  it('ウェイポイントテンプレートの height / heightMode を読む', () => {
    const t = parseTemplateKml(buildTemplateKml(mission));
    expect(t.waylines).toHaveLength(2);
    expect(t.waylines[0].waypoints[0]).toMatchObject({ executeHeight: 60, heightMode: 'relativeToStartPoint', source: 'template.kml' });
    expect(t.folders[0].templateType).toBe('waypoint');
  });

  it('mapping2d テンプレートはポリゴンのみ取り出し、警告を出す', () => {
    const t = parseTemplateKml(
      buildTemplateKml({ waylines: [], mappingPolygon: [[1, 2], [3, 2], [3, 4], [1, 2]] }),
    );
    expect(t.waylines).toHaveLength(0);
    expect(t.folders[0].polygons[0]).toHaveLength(4);
    expect(t.warnings.join()).toContain('mapping2d');
  });
});

describe('parseKmz', () => {
  it('wpmz/waylines.wpml を優先し、template.kml の離陸地点を併用する', async () => {
    const m = await parseKmz(await buildKmz(mission), 'a.kmz');
    expect(m.source).toBe('waylines.wpml');
    expect(m.files.sort()).toEqual(['wpmz/template.kml', 'wpmz/waylines.wpml']);
    expect(m.takeoffRef?.ellipsoidHeight).toBe(117.5);
    expect(m.waylines).toHaveLength(2);
  });

  it('waylines.wpml がない場合は template.kml から読む', async () => {
    const m = await parseKmz(await buildKmz({ ...mission, omitWaylines: true }));
    expect(m.source).toBe('template.kml');
    expect(m.waylines[1].waypoints).toHaveLength(3);
    expect(m.warnings.join()).toContain('waylines.wpml がない');
  });

  it('どちらもない場合は空の結果と警告を返す', async () => {
    const zip = new JSZip();
    zip.file('readme.txt', 'x');
    const m = await parseKmz(await zip.generateAsync({ type: 'uint8array' }));
    expect(m.source).toBeNull();
    expect(m.waylines).toEqual([]);
    expect(m.warnings.length).toBeGreaterThan(0);
  });
});
