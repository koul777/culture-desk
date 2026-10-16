import { XMLParser } from 'fast-xml-parser';
import { ProviderError } from './errors.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => name === 'db' || name === 'item' || name === 'styurl',
});

export function parseXmlDocument(xml: string): Record<string, unknown> {
  try {
    const doc = parser.parse(xml) as Record<string, unknown>;
    if (!doc || typeof doc !== 'object') throw new ProviderError('schema', 'empty xml');
    return doc;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('schema', 'xml parse failed');
  }
}

export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function readRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return value as Record<string, string>;
}
