import { useEffect, useRef, useState } from 'react';
import { Box, ExternalLink, Focus, LoaderCircle, Minus, Plus, RotateCcw, RotateCw } from 'lucide-react';
import {
  BoundingSphere, Cartesian2, Cartesian3, Color, Credit, EllipsoidTerrainProvider, HeadingPitchRange,
  HeightReference, HorizontalOrigin, ImageryLayer, Ion, LabelStyle, Math as CesiumMath,
  OpenStreetMapImageryProvider, PolygonHierarchy, VerticalOrigin, Viewer,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import '../venue-3d.css';
import { safeUrl } from '../lib/format';
import { Modal } from './Modal';
import { canViewVenue3D, type Venue3DLocation } from './Venue3D';

type Ring = number[][];
interface VenueBuilding {
  type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][];
  heightMeters: number | null; heightSource: 'tag' | 'levels' | 'unknown'; estimatedHeight: boolean;
  name: string; sourceUrl: string; osmType: string; osmId: number;
  confidence: 'coordinate_and_name' | 'coordinate' | 'name_nearby'; matchMethod: string; distanceMeters: number;
}
interface BuildingResult {
  status: 'available' | 'unavailable'; performanceId: number; source: string; attribution: string;
  building: VenueBuilding | null; message: string; reason?: string; checkedAt: string;
}
const positionList = (ring: Ring) => Cartesian3.fromDegreesArray(ring.flatMap(point => [point[0], point[1]]));

export default function Venue3DDialog({ item, onClose }: { item: Venue3DLocation; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const view = useRef({ center: Cartesian3.fromDegrees(item.longitude ?? 127.8, item.latitude ?? 36.2), heading: 25, range: 380 });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [imageryError, setImageryError] = useState(false);
  const [building, setBuilding] = useState<BuildingResult | null>(null);
  const [buildingLoading, setBuildingLoading] = useState(true);
  const frame = () => {
    if (!viewer.current || viewer.current.isDestroyed()) return;
    const { center, heading, range } = view.current;
    viewer.current.camera.lookAt(center, new HeadingPitchRange(CesiumMath.toRadians(heading), CesiumMath.toRadians(-38), range));
    viewer.current.scene.requestRender();
  };

  useEffect(() => {
    if (!host.current || !canViewVenue3D(item)) { setError('공연장의 정확한 위치가 없어 3D 지도를 표시할 수 없습니다.'); return; }
    let current: Viewer | undefined;
    let disposed = false;
    const controller = new AbortController();
    let resize: ResizeObserver | undefined;
    try {
      // No Cesium ion request or API key is needed for this viewer.
      Ion.defaultAccessToken = '';
      const imagery = new OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/', maximumLevel: 19,
        credit: new Credit('&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors', true) });
      imagery.errorEvent.addEventListener(() => { if (!disposed) setImageryError(true); });
      current = new Viewer(host.current, {
        baseLayer: new ImageryLayer(imagery), terrainProvider: new EllipsoidTerrainProvider(),
        baseLayerPicker: false, animation: false, timeline: false, geocoder: false, homeButton: false,
        sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false,
        infoBox: false, selectionIndicator: false, scene3DOnly: true,
        requestRenderMode: true, maximumRenderTimeChange: Infinity, shouldAnimate: false,
        showRenderLoopErrors: false, contextOptions: { webgl: { alpha: false } },
      });
      viewer.current = current;
      current.resolutionScale = .85;
      current.scene.msaaSamples = 1;
      current.scene.globe.maximumScreenSpaceError = 3;
      current.scene.globe.enableLighting = false;
      current.scene.globe.baseColor = Color.fromCssColorString('#e7ece5');
      current.scene.screenSpaceCameraController.minimumZoomDistance = 35;
      current.scene.screenSpaceCameraController.maximumZoomDistance = 50000;
      current.scene.renderError.addEventListener(() => { if (!disposed) setError('3D 화면을 그리지 못했습니다. 브라우저의 하드웨어 가속을 켠 뒤 다시 열어주세요.'); });
      current.canvas.setAttribute('aria-label', `${item.venue || '공연장'} 3D 지도. 화면 위 확대, 축소, 회전 버튼으로 조작할 수 있습니다.`);
      current.entities.add({ id: 'venue-location', name: item.venue || '공연장', position: Cartesian3.fromDegrees(item.longitude!, item.latitude!, 2),
        point: { pixelSize: 13, color: Color.fromCssColorString('#ed784d'), outlineColor: Color.WHITE, outlineWidth: 3, disableDepthTestDistance: Infinity },
        label: { text: item.venue || '공연장', font: '600 15px sans-serif', style: LabelStyle.FILL_AND_OUTLINE, fillColor: Color.WHITE,
          outlineColor: Color.fromCssColorString('#17323e'), outlineWidth: 3, showBackground: true, backgroundColor: Color.fromCssColorString('#17323ed9'),
          backgroundPadding: new Cartesian2(10, 7), pixelOffset: new Cartesian2(0, -25), horizontalOrigin: HorizontalOrigin.CENTER,
          verticalOrigin: VerticalOrigin.BOTTOM, disableDepthTestDistance: Infinity, heightReference: HeightReference.NONE },
      });
      view.current = { center: Cartesian3.fromDegrees(item.longitude!, item.latitude!), heading: 25, range: 380 };
      frame();
      const markRendered = () => { if (!disposed) setReady(true); current?.scene.postRender.removeEventListener(markRendered); };
      current.scene.postRender.addEventListener(markRendered);
      resize = new ResizeObserver(() => { if (current && !current.isDestroyed()) { current.resize(); current.scene.requestRender(); } });
      resize.observe(host.current);
      void (async () => {
        try {
          const response = await fetch(`/api/venues/building?performanceId=${item.id}`, { credentials: 'same-origin', signal: controller.signal });
          if (!response.ok) throw new Error('건물 외곽 정보를 확인하지 못했습니다. 공연장 위치를 표시합니다.');
          const result = await response.json() as BuildingResult;
          if (disposed || !current || current.isDestroyed()) return;
          setBuilding(result);
          const found = result.building;
          if (result.status === 'available' && found) {
            const polygons = found.type === 'Polygon' ? [found.coordinates as number[][][]] : found.coordinates as number[][][][];
            const points: Cartesian3[] = [];
            const height = typeof found.heightMeters === 'number' && found.heightMeters > 0 ? found.heightMeters : undefined;
            for (const [index, rings] of polygons.entries()) {
              if (!rings[0]?.length) continue;
              const outer = positionList(rings[0]); points.push(...outer);
              current.entities.add({ id: `venue-building-${index}`, name: found.name || item.venue,
                polygon: { hierarchy: new PolygonHierarchy(outer, rings.slice(1).map(ring => new PolygonHierarchy(positionList(ring)))),
                  height: 0, extrudedHeight: height, material: Color.fromCssColorString(height ? '#1e8175' : '#e5a657').withAlpha(.88),
                  outline: true, outlineColor: Color.fromCssColorString('#f8ead5'), closeTop: true, closeBottom: true },
              });
            }
            if (points.length) {
              const sphere = BoundingSphere.fromPoints(points);
              view.current.center = sphere.center;
              view.current.range = Math.max(240, sphere.radius * 5, (height ?? 0) * 6);
              frame();
            }
            current.scene.requestRender();
          }
        } catch (cause) {
          if (!disposed && !(cause instanceof DOMException && cause.name === 'AbortError')) setBuilding({
            status: 'unavailable', performanceId: item.id, source: 'OpenStreetMap', attribution: '', building: null,
            message: cause instanceof Error ? cause.message : '건물 정보를 불러오지 못해 공연장 위치만 표시합니다.', checkedAt: '',
          });
        } finally { if (!disposed) setBuildingLoading(false); }
      })();
    } catch { setError('이 브라우저에서 WebGL 3D를 시작할 수 없습니다. 하드웨어 가속을 지원하는 Chrome 또는 Edge에서 다시 열어주세요.'); setBuildingLoading(false); }
    return () => { disposed = true; controller.abort(); resize?.disconnect(); if (current && !current.isDestroyed()) current.destroy(); viewer.current = null; };
  }, [item.id, item.latitude, item.longitude]);

  const found = building?.building;
  const source = found ? safeUrl(found.sourceUrl) : null;
  const geometryLabel = buildingLoading ? '건물 정보 확인 중' : !found ? '위치만 표시' : found.heightMeters ? '건물 3D 표시' : '건물 외곽 표시';
  return <Modal open onClose={onClose} title={`${item.venue || '공연장'} · 3D`} subtitle={<p className="venue-3d-sub">공연장 위치와 확인된 건물 외곽을 입체 지도에서 살펴보세요.</p>}>
    <section className="venue-3d" data-testid="venue-3d" data-ready={ready} data-geometry={found ? 'building' : 'location'}>
      <div className="venue-3d-toolbar" aria-label="3D 지도 조작">
        <span className={`venue-3d-badge${found ? ' has-building' : ''}`}><Box size={15} aria-hidden="true" />{geometryLabel}</span>
        <div className="venue-3d-controls">
          <button type="button" onClick={() => { view.current.range = Math.max(65, view.current.range * .72); frame(); }} disabled={!ready || !!error} aria-label="3D 지도 확대"><Plus size={18} /></button>
          <button type="button" onClick={() => { view.current.range = Math.min(25000, view.current.range * 1.4); frame(); }} disabled={!ready || !!error} aria-label="3D 지도 축소"><Minus size={18} /></button>
          <button type="button" onClick={() => { view.current.heading -= 30; frame(); }} disabled={!ready || !!error} aria-label="왼쪽으로 회전"><RotateCcw size={17} /></button>
          <button type="button" onClick={() => { view.current.heading += 30; frame(); }} disabled={!ready || !!error} aria-label="오른쪽으로 회전"><RotateCw size={17} /></button>
          <button type="button" onClick={() => { view.current.heading = 25; frame(); }} disabled={!ready || !!error} aria-label="공연장 중심으로 보기"><Focus size={18} /></button>
        </div>
      </div>
      <div className="venue-3d-stage">
        <div ref={host} className="venue-3d-canvas" />
        {!ready && !error && <div className="venue-3d-loading" role="status"><LoaderCircle size={26} className="spin" /><strong>3D 지도를 불러오는 중</strong></div>}
        {error && <div className="venue-3d-loading venue-3d-error" role="alert"><strong>3D 화면을 표시할 수 없습니다</strong><p>{error}</p><button type="button" className="button" onClick={onClose}>돌아가기</button></div>}
      </div>
      <div className="venue-3d-info" role="status">
        <strong>{buildingLoading ? '공연장 좌표를 표시하고 실제 건물 외곽을 확인하고 있습니다.' : found ? found.heightMeters ? `실제 건물 외곽 · 높이 ${found.heightMeters}m${found.estimatedHeight ? ' (층수 기반 추정)' : ' (OSM 기록)'}` : '실제 건물 외곽을 표시했습니다. 높이 자료가 없어 입체 건물로 만들지 않습니다.' : building?.message || '확인된 건물 정보가 없어 공연장 위치만 표시합니다.'}</strong>
        {found && <p>{found.confidence === 'coordinate' ? '공연장 좌표를 포함하는 건물입니다. 건물명 일치는 확인되지 않았습니다.' : found.confidence === 'name_nearby' ? '공연장명과 가까운 위치가 일치한 건물입니다.' : '공연장 좌표와 건물명이 일치합니다.'}{source && <> <a href={source} target="_blank" rel="noopener noreferrer">건물 원자료 <ExternalLink size={12} aria-hidden="true" /></a></>}</p>}
        {imageryError && <p>일부 지도 배경을 가져오지 못했습니다. 위치와 확인된 건물은 계속 볼 수 있습니다.</p>}
        <p className="venue-3d-help">드래그로 이동 · 휠로 확대 · Ctrl + 드래그로 회전 · 지형 높이는 반영하지 않은 평면 기준입니다.</p>
      </div>
    </section>
  </Modal>;
}
