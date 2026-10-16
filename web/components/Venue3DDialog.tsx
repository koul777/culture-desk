import { useEffect, useId, useRef, useState } from 'react';
import { Box, Check, ExternalLink, Focus, Layers3, LoaderCircle, Minus, Plus, RotateCcw, RotateCw } from 'lucide-react';
import {
  BoundingSphere, Cartesian2, Cartesian3, Cartographic, Color, ConstantProperty, Credit,
  EllipsoidTerrainProvider, Entity, HeadingPitchRange, HorizontalOrigin, ImageryLayer, Ion, LabelStyle,
  Math as CesiumMath, OpenStreetMapImageryProvider, PolygonHierarchy, VerticalOrigin, Viewer,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import '../venue-3d.css';
import { safeUrl } from '../lib/format';
import { buildingCameraRange, DEFAULT_ASSUMED_HEIGHT, MAX_ASSUMED_HEIGHT, MIN_ASSUMED_HEIGHT, venueHeightModel, zoomedDistance, type BuildingHeight } from '../lib/venue-3d';
import { Modal } from './Modal';
import { canViewVenue3D, type Venue3DLocation } from './Venue3D';

type Ring = number[][];
interface VenueBuilding extends BuildingHeight {
  type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][];
  name: string; sourceUrl: string; osmType: string; osmId: number;
  confidence: 'coordinate_and_name' | 'coordinate' | 'name_nearby'; matchMethod: string; distanceMeters: number;
}
interface BuildingResult {
  status: 'available' | 'unavailable'; performanceId: number; source: string; attribution: string;
  building: VenueBuilding | null; message: string; reason?: string; checkedAt: string;
}
type TileState = 'loading' | 'ready' | 'partial' | 'timeout';
type ViewMode = 'perspective' | 'top' | 'custom';
const PITCH = -32;
const TILE_TIMEOUT_MS = 12000;
// The server can try two providers for up to 10 seconds each.
const BUILDING_TIMEOUT_MS = 25000;
const RENDER_TIMEOUT_MS = 30000;
const positionList = (ring: Ring) => Cartesian3.fromDegreesArray(ring.flatMap(point => [point[0], point[1]]));

export default function Venue3DDialog({ item, onClose }: { item: Venue3DLocation; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const buildingEntities = useRef<Entity[]>([]);
  const home = useRef({ center: Cartesian3.fromDegrees(item.longitude ?? 127.8, item.latitude ?? 36.2), range: 380, radius: 60, surface: null as Cartographic | null });
  const [sceneReady, setSceneReady] = useState(false);
  const [tiles, setTiles] = useState<TileState>('loading');
  const [error, setError] = useState('');
  const [building, setBuilding] = useState<BuildingResult | null>(null);
  const [buildingLoading, setBuildingLoading] = useState(true);
  const [assumedHeight, setAssumedHeight] = useState(DEFAULT_ASSUMED_HEIGHT);
  const [mode, setMode] = useState<ViewMode>('perspective');
  const [attempt, setAttempt] = useState(0);
  const heightId = useId();
  const found = building?.status === 'available' ? building.building : null;
  const model = venueHeightModel(found ?? null, assumedHeight);
  const loading = !sceneReady || tiles === 'loading' || buildingLoading;
  const source = found ? safeUrl(found.sourceUrl) : null;

  const pose = (next: 'perspective' | 'top', reset = false) => {
    const current = viewer.current;
    if (!current || current.isDestroyed()) return;
    const range = reset ? home.current.range : Math.max(35, Cartesian3.distance(current.camera.positionWC, home.current.center));
    const heading = reset ? 40 : CesiumMath.toDegrees(current.camera.heading);
    current.camera.lookAt(home.current.center, new HeadingPitchRange(CesiumMath.toRadians(heading), CesiumMath.toRadians(next === 'top' ? -89.5 : PITCH), range));
    current.scene.requestRender(); setMode(next);
  };
  const zoom = (direction: 'in' | 'out') => {
    const current = viewer.current;
    if (!current || current.isDestroyed()) return;
    const distance = Cartesian3.magnitude(current.camera.position);
    const amount = zoomedDistance(distance, direction) - distance;
    if (amount >= 0) current.camera.zoomOut(amount); else current.camera.zoomIn(-amount);
    current.scene.requestRender();
  };
  const rotate = (direction: 'left' | 'right') => {
    const current = viewer.current;
    if (!current || current.isDestroyed()) return;
    // Native relative controls preserve the current pan, tilt, and zoom.
    current.camera[direction === 'left' ? 'rotateLeft' : 'rotateRight'](CesiumMath.toRadians(20));
    current.scene.requestRender();
  };

  useEffect(() => {
    if (!host.current || !canViewVenue3D(item)) { setError('공연장의 정확한 위치가 없어 3D 지도를 표시할 수 없습니다.'); return; }
    let current: Viewer | undefined;
    let disposed = false;
    let buildingResolved = false;
    let tileQueueSeen = false;
    let tileFailed = false;
    let visualReady = false;
    let renderedFrames = 0;
    let buildingTimedOut = false;
    let tileTimer: ReturnType<typeof setTimeout> | undefined;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    let renderTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    let resize: ResizeObserver | undefined;
    setSceneReady(false); setTiles('loading'); setError(''); setBuilding(null); setBuildingLoading(true);
    setAssumedHeight(DEFAULT_ASSUMED_HEIGHT); setMode('perspective'); buildingEntities.current = [];
    try {
      Ion.defaultAccessToken = '';
      const imagery = new OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/', maximumLevel: 19,
        credit: new Credit('&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors', true) });
      imagery.errorEvent.addEventListener(() => { tileFailed = true; });
      current = new Viewer(host.current, {
        baseLayer: new ImageryLayer(imagery), terrainProvider: new EllipsoidTerrainProvider(),
        baseLayerPicker: false, animation: false, timeline: false, geocoder: false, homeButton: false,
        sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false,
        infoBox: false, selectionIndicator: false, scene3DOnly: true, skyBox: false, skyAtmosphere: false,
        requestRenderMode: true, maximumRenderTimeChange: Infinity, shouldAnimate: false,
        showRenderLoopErrors: false, contextOptions: { webgl: { alpha: false } },
      });
      viewer.current = current;
      current.resolutionScale = Math.min(1, window.devicePixelRatio);
      current.scene.msaaSamples = 2;
      current.scene.globe.maximumScreenSpaceError = 2;
      current.scene.globe.enableLighting = false;
      current.scene.globe.baseColor = Color.fromCssColorString('#e7ece5');
      current.scene.backgroundColor = Color.fromCssColorString('#e7ece5');
      current.scene.screenSpaceCameraController.minimumZoomDistance = 35;
      current.scene.screenSpaceCameraController.maximumZoomDistance = 50000;
      current.scene.renderError.addEventListener(() => { if (!disposed) setError('3D 화면을 그리지 못했습니다. 브라우저의 하드웨어 가속을 확인한 뒤 다시 시도해주세요.'); });
      current.canvas.setAttribute('aria-label', `${item.venue || '공연장'} 3D 지도. 위의 확대, 회전, 보기 전환 버튼으로 조작할 수 있습니다.`);
      const markCustom = () => setMode('custom');
      current.canvas.addEventListener('pointerdown', markCustom);
      current.canvas.addEventListener('wheel', markCustom, { passive: true });
      const location = current.entities.add({ id: 'venue-location', name: item.venue || '공연장', position: Cartesian3.fromDegrees(item.longitude!, item.latitude!, 2),
        point: { pixelSize: 11, color: Color.fromCssColorString('#ed784d'), outlineColor: Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Infinity },
        label: { text: item.venue || '공연장', font: '600 14px sans-serif', style: LabelStyle.FILL_AND_OUTLINE, fillColor: Color.WHITE,
          outlineColor: Color.fromCssColorString('#17323e'), outlineWidth: 3, showBackground: true, backgroundColor: Color.fromCssColorString('#17323ed9'),
          backgroundPadding: new Cartesian2(8, 5), pixelOffset: new Cartesian2(0, -20), horizontalOrigin: HorizontalOrigin.CENTER,
          verticalOrigin: VerticalOrigin.BOTTOM, disableDepthTestDistance: Infinity },
      });
      home.current = { center: Cartesian3.fromDegrees(item.longitude!, item.latitude!), range: 380, radius: 60, surface: null };
      pose('perspective', true);
      current.scene.globe.tileLoadProgressEvent.addEventListener((count: number) => { if (count > 0) tileQueueSeen = true; });
      current.scene.postRender.addEventListener(() => {
        if (disposed || !current) return;
        renderedFrames++;
        if (renderedFrames > 1 && tileQueueSeen && current.scene.globe.tilesLoaded) {
          setTiles(tileFailed ? 'partial' : 'ready'); clearTimeout(tileTimer);
        }
        if (!visualReady && renderedFrames > 1 && buildingResolved && current.dataSourceDisplay.ready) {
          visualReady = true; setSceneReady(true); clearTimeout(renderTimer);
        }
      });
      tileTimer = setTimeout(() => { if (!disposed) setTiles('timeout'); }, TILE_TIMEOUT_MS);
      renderTimer = setTimeout(() => { if (!disposed && !visualReady) setError('3D 화면 준비가 지연되고 있습니다. 연결 상태를 확인하고 다시 시도해주세요.'); }, RENDER_TIMEOUT_MS);
      resize = new ResizeObserver(() => { if (current && !current.isDestroyed()) { current.resize(); current.scene.requestRender(); } });
      resize.observe(host.current);
      requestTimer = setTimeout(() => { buildingTimedOut = true; controller.abort(); }, BUILDING_TIMEOUT_MS);
      void (async () => {
        try {
          const response = await fetch(`/api/venues/building?performanceId=${item.id}`, { credentials: 'same-origin', signal: controller.signal });
          if (!response.ok) throw new Error('건물 정보를 가져오지 못했습니다. 공연장 위치만 표시합니다.');
          const result = await response.json() as BuildingResult;
          if (disposed || !current || current.isDestroyed()) return;
          clearTimeout(requestTimer);
          setBuilding(result); setBuildingLoading(false);
          const shape = result.status === 'available' ? result.building : null;
          const height = venueHeightModel(shape, DEFAULT_ASSUMED_HEIGHT);
          if (shape && height) {
            const polygons = shape.type === 'Polygon' ? [shape.coordinates as number[][][]] : shape.coordinates as number[][][][];
            const points: Cartesian3[] = [];
            for (const [index, rings] of polygons.entries()) {
              if (!rings[0]?.length) continue;
              const outer = positionList(rings[0]); points.push(...outer);
              buildingEntities.current.push(current.entities.add({ id: `venue-building-${index}`, name: shape.name || item.venue,
                polygon: { hierarchy: new PolygonHierarchy(outer, rings.slice(1).map(ring => new PolygonHierarchy(positionList(ring)))),
                  height: 0, extrudedHeight: height.meters, material: Color.fromCssColorString(height.kind === 'assumed' ? '#c7964e' : '#238576'),
                  outline: true, outlineColor: Color.fromCssColorString('#fff5df'), closeTop: true, closeBottom: true },
              }));
            }
            if (points.length) {
              // The model identifies the venue; the name and pin would conceal its roof.
              location.show = false;
              const sphere = BoundingSphere.fromPoints(points);
              const surface = Cartographic.fromCartesian(sphere.center);
              home.current = { center: Cartesian3.fromRadians(surface.longitude, surface.latitude, height.meters / 2), radius: sphere.radius, surface,
                range: buildingCameraRange(sphere.radius, height.meters, host.current!.clientWidth / host.current!.clientHeight) };
              // zoomTo resolves after these entities' geometry is ready; DataSourceDisplay.ready
              // alone is sticky and may still describe the earlier location marker.
              const framed = await current.zoomTo(buildingEntities.current, new HeadingPitchRange(CesiumMath.toRadians(40), CesiumMath.toRadians(PITCH), home.current.range));
              if (disposed || current.isDestroyed()) return;
              if (!framed) { setError('건물 모형을 화면에 준비하지 못했습니다. 다시 시도해주세요.'); return; }
              pose('perspective', true);
            }
          }
        } catch {
          if (!disposed) {
            if (current && !current.isDestroyed()) {
              for (const entity of buildingEntities.current) current.entities.remove(entity);
              buildingEntities.current = []; location.show = true;
              home.current = { center: Cartesian3.fromDegrees(item.longitude!, item.latitude!), range: 380, radius: 60, surface: null };
              pose('perspective', true);
            }
            setBuilding({ status: 'unavailable', performanceId: item.id, source: 'OpenStreetMap', attribution: '', building: null,
              message: buildingTimedOut ? '건물 자료 확인 시간이 초과되어 위치만 표시합니다. 다시 시도할 수 있습니다.' : '건물 자료를 불러오지 못해 위치만 표시합니다. 잠시 후 다시 시도해주세요.',
              reason: buildingTimedOut ? 'timeout' : 'upstream_unavailable', checkedAt: '' });
          }
        } finally {
          clearTimeout(requestTimer);
          if (!disposed) { buildingResolved = true; setBuildingLoading(false); current?.scene.requestRender(); }
        }
      })();
    } catch {
      setError('이 브라우저에서 WebGL 3D를 시작할 수 없습니다. 하드웨어 가속을 지원하는 Chrome 또는 Edge에서 다시 열어주세요.');
      setBuildingLoading(false);
    }
    return () => {
      disposed = true; controller.abort(); clearTimeout(tileTimer); clearTimeout(requestTimer); clearTimeout(renderTimer);
      resize?.disconnect(); if (current && !current.isDestroyed()) current.destroy(); viewer.current = null; buildingEntities.current = [];
    };
  }, [item.id, item.latitude, item.longitude, attempt]);

  useEffect(() => {
    const current = viewer.current;
    if (!current || current.isDestroyed() || model?.kind !== 'assumed') return;
    for (const entity of buildingEntities.current) if (entity.polygon) entity.polygon.extrudedHeight = new ConstantProperty(model.meters);
    const { surface, radius } = home.current;
    if (surface && host.current) {
      home.current.center = Cartesian3.fromRadians(surface.longitude, surface.latitude, model.meters / 2);
      home.current.range = buildingCameraRange(radius, model.meters, host.current.clientWidth / host.current.clientHeight);
    }
    current.scene.requestRender();
  }, [assumedHeight, found]);

  const controlsDisabled = loading || !!error;
  return <Modal open onClose={onClose} title={`${item.venue || '공연장'} · 3D`} subtitle={<p className="venue-3d-sub">확인된 건물 외곽을 입체 모형으로 둘러보세요.</p>}>
    <section className="venue-3d" data-testid="venue-3d" data-ready={!loading && !error} data-geometry={found ? 'building' : 'location'} data-height-kind={model?.kind ?? 'none'}>
      <div className="venue-3d-toolbar">
        <span className={`venue-3d-badge${model ? model.kind === 'assumed' ? ' is-assumed' : ' has-building' : ''}`}><Box size={15} aria-hidden="true" />{buildingLoading ? '건물 정보 확인 중' : model?.label ?? '위치만 표시'}</span>
        <div className="venue-3d-view-switch" role="group" aria-label="3D 보기 방식">
          <button type="button" aria-pressed={mode === 'perspective'} disabled={controlsDisabled} onClick={() => pose('perspective')}><Layers3 size={15} aria-hidden="true" />입체 보기</button>
          <button type="button" aria-pressed={mode === 'top'} disabled={controlsDisabled} onClick={() => pose('top')}>위에서 보기</button>
        </div>
      </div>
      {model?.kind === 'assumed' && <div className="venue-3d-height-control">
        <div><label htmlFor={heightId}>모형 높이 가정</label><output htmlFor={heightId}>{model.meters}m</output><span>실측 높이가 아닙니다</span></div>
        <input id={heightId} type="range" min={MIN_ASSUMED_HEIGHT} max={MAX_ASSUMED_HEIGHT} step="1" value={assumedHeight} aria-valuetext={`${model.meters}미터, 사용자 가정 높이`} onChange={event => setAssumedHeight(Number(event.target.value))} />
        <p>실제 건물 외곽에 가정 높이를 적용합니다. 원본 높이 정보는 변경하지 않습니다.</p>
      </div>}
      <div className="venue-3d-stage" aria-busy={loading && !error}>
        <div ref={host} className={`venue-3d-canvas${loading || error ? ' is-preparing' : ''}`} />
        {loading && !error && <div className="venue-3d-loading" role="status">
          <LoaderCircle size={25} className="spin" aria-hidden="true" /><strong>공연장 화면을 준비하고 있습니다</strong>
          <div className="venue-3d-loading-steps"><span>{tiles === 'loading' ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}지도 배경 {tiles === 'loading' ? '불러오는 중' : tiles === 'ready' ? '준비됨' : '연결 확인 필요'}</span><span>{buildingLoading ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}건물 자료 {buildingLoading ? '확인 중' : model ? '확인됨' : '위치만 제공'}</span></div>
        </div>}
        {error && <div className="venue-3d-loading venue-3d-error" role="alert"><strong>3D 화면을 준비하지 못했습니다</strong><p>{error}</p><button type="button" className="button" onClick={() => setAttempt(value => value + 1)}>다시 시도</button></div>}
      </div>
      <div className="venue-3d-controls" role="group" aria-label="3D 지도 조작">
        <button type="button" disabled={controlsDisabled} onClick={() => zoom('in')} aria-label="3D 지도 확대"><Plus size={18} aria-hidden="true" /></button>
        <button type="button" disabled={controlsDisabled} onClick={() => zoom('out')} aria-label="3D 지도 축소"><Minus size={18} aria-hidden="true" /></button>
        <button type="button" disabled={controlsDisabled} onClick={() => rotate('left')} aria-label="왼쪽으로 회전"><RotateCcw size={18} aria-hidden="true" /></button>
        <button type="button" disabled={controlsDisabled} onClick={() => rotate('right')} aria-label="오른쪽으로 회전"><RotateCw size={18} aria-hidden="true" /></button>
        <button type="button" disabled={controlsDisabled} className="venue-3d-reset" onClick={() => pose('perspective', true)}><Focus size={17} aria-hidden="true" /><span>초기 구도</span></button>
      </div>
      <div className="venue-3d-info" role="status">
        <strong>{buildingLoading ? '실제 건물 외곽과 높이 정보를 확인하고 있습니다.' : model ? model.kind === 'assumed' ? `실제 외곽 · 높이 ${model.meters}m 가정 모형 (실측 아님)` : model.kind === 'levels' ? `실제 외곽 · 높이 ${model.meters}m (층수 기반 추정)` : `실제 외곽 · 높이 ${model.meters}m (OSM 기록)` : building?.message || '확인된 건물 외곽이 없어 공연장 위치만 표시합니다.'}</strong>
        {found && <p>{found.confidence === 'coordinate' ? '공연장 좌표를 포함하는 외곽입니다. 건물명 일치는 확인되지 않았습니다.' : found.confidence === 'name_nearby' ? '공연장명과 가까운 위치가 일치한 외곽입니다.' : '공연장 좌표와 건물명이 일치합니다.'}{source && <> <a href={source} target="_blank" rel="noopener noreferrer">건물 원자료 <ExternalLink size={12} aria-hidden="true" /></a></>}</p>}
        {model && <p>건물 외곽과 높이로 만든 모형이며 실제 지붕·외벽의 모습을 재현하지는 않습니다.</p>}
        {(tiles === 'partial' || tiles === 'timeout') && <p className="venue-3d-warning">지도 배경 {tiles === 'timeout' ? '로딩 시간이 초과되었습니다' : '일부를 가져오지 못했습니다'}. 확인된 모형과 위치는 계속 볼 수 있습니다. <button type="button" className="text-button" onClick={() => setAttempt(value => value + 1)}>다시 불러오기</button></p>}
        {!buildingLoading && !model && !error && <button type="button" className="text-button" onClick={() => setAttempt(value => value + 1)}>건물 자료 다시 확인</button>}
        <p className="venue-3d-help">드래그로 이동 · 휠로 확대 · Ctrl + 드래그로 회전 · 지형 높이는 반영하지 않습니다.</p>
      </div>
    </section>
  </Modal>;
}
