import type { City } from '../../shared/types.js';
import { NATIONAL_REGION_CATALOG } from './national-cities.js';

/** KOPIS region codes. Coordinates are approximate city centres, not venue positions. */
export const DEFAULT_CITIES: City[] = [
  {
    id: 'andong',
    latitude: 36.5684, longitude: 128.7294,
    name: '안동',
    sido: '경상북도',
    sigungu: '안동시',
    kopisSido: '47',
    kopisSigungu: '4717',
    aliases: ['경북 안동', '안동시'],
  },
  {
    id: 'yeosu',
    latitude: 34.7604, longitude: 127.6622,
    name: '여수',
    sido: '전남광주통합특별시',
    sigungu: '여수시',
    kopisSido: '12',
    kopisSigungu: '1213',
    aliases: ['전남 여수', '여수시', '전남광주 여수'],
  },
  {
    id: 'suncheon',
    latitude: 34.9507, longitude: 127.4872,
    name: '순천',
    sido: '전남광주통합특별시',
    sigungu: '순천시',
    kopisSido: '12',
    kopisSigungu: '1215',
    aliases: ['전남 순천', '순천시', '전남광주 순천'],
  },
  {
    id: 'gangneung',
    latitude: 37.7519, longitude: 128.8761,
    name: '강릉',
    sido: '강원특별자치도',
    sigungu: '강릉시',
    kopisSido: '51',
    kopisSigungu: '5115',
    aliases: ['강원 강릉', '강릉시'],
  },
  {
    id: 'wonju',
    latitude: 37.3422, longitude: 127.9202,
    name: '원주',
    sido: '강원특별자치도',
    sigungu: '원주시',
    kopisSido: '51',
    kopisSigungu: '5113',
    aliases: ['강원 원주', '원주시'],
  },
  {
    id: 'chungju',
    latitude: 36.9910, longitude: 127.9259,
    name: '충주',
    sido: '충청북도',
    sigungu: '충주시',
    kopisSido: '43',
    kopisSigungu: '4313',
    aliases: ['충북 충주', '충주시'],
  },
  {
    id: 'gongju',
    latitude: 36.4465, longitude: 127.1190,
    name: '공주',
    sido: '충청남도',
    sigungu: '공주시',
    kopisSido: '44',
    kopisSigungu: '4415',
    aliases: ['충남 공주', '공주시'],
  },
];

/** Complete current KOPIS municipality catalog, retaining the original seven stable IDs and centres. */
export const NATIONAL_CITIES: City[] = NATIONAL_REGION_CATALOG.map(city => {
  const existing = DEFAULT_CITIES.find(seed => seed.kopisSigungu === city.kopisSigungu);
  return existing ? { ...city, ...existing, aliases: [...new Set([...city.aliases, ...existing.aliases])] } : city;
});
