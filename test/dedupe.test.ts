import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { setRenameHooks } from '../src/atomic-rename.js';
import { DedupeStore } from '../src/dedupe.js';
import { captureLogs, useTempDir } from './helpers.js';

const DAY = 86_400;

describe('DedupeStore', () => {
  const tmp = useTempDir();
  const logs = captureLogs();
  const file = (): string => path.join(tmp(), 'state', 'relayed.json');

  it('starts fresh, persists markers and the watermark, and reloads them', () => {
    const store = new DedupeStore(file(), { retentionSeconds: 10 * DAY });
    store.load();
    expect(store.fresh).toBe(true);
    expect(store.watermark).toBeNull();
    const now = Math.floor(Date.now() / 1000);
    store.mark('a:1:0', 'recorded', now - 10);
    store.mark('a:1:0', 'relayed', now - 10);
    store.mark('b:2:0', 'recorded', now - 5);

    const reloaded = new DedupeStore(file(), { retentionSeconds: 10 * DAY });
    reloaded.load();
    expect(reloaded.fresh).toBe(false);
    expect(reloaded.state('a:1:0')).toBe('relayed');
    expect(reloaded.state('b:2:0')).toBe('recorded');
    expect(reloaded.state('c:3:0')).toBeUndefined();
    expect(reloaded.watermark).toBe(now - 5);
    expect(reloaded.pending()).toEqual(['b:2:0']);
  });

  it('never moves the watermark backwards', () => {
    const store = new DedupeStore(file(), { retentionSeconds: 10 * DAY });
    store.load();
    const now = Math.floor(Date.now() / 1000);
    store.mark('x:1:0', 'relayed', now);
    store.mark('y:1:0', 'relayed', now - 1000);
    expect(store.watermark).toBe(now);
  });

  it('evicts markers older than the retention window on load', () => {
    const now = Math.floor(Date.now() / 1000);
    const store = new DedupeStore(file(), { retentionSeconds: DAY });
    store.load();
    store.mark('old:1:0', 'relayed', now - 2 * DAY);
    store.mark('new:1:0', 'relayed', now - 60);
    const reloaded = new DedupeStore(file(), { retentionSeconds: DAY });
    reloaded.load();
    expect(reloaded.state('old:1:0')).toBeUndefined();
    expect(reloaded.state('new:1:0')).toBe('relayed');
    expect(logs.some((e) => e.event === 'DEDUPE_EVICTED' && e['evicted'] === 1)).toBe(true);
  });

  it('moves a corrupt file aside, logs it, and starts empty without claiming a first run', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '{"version":1,"markers":');
    const store = new DedupeStore(file(), { retentionSeconds: DAY });
    store.load();
    expect(store.fresh).toBe(false);
    expect(store.state('anything')).toBeUndefined();
    const aside = fs.readdirSync(path.dirname(file())).filter((f) => f.includes('.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(logs.some((e) => e.event === 'DEDUPE_STATE_CORRUPT')).toBe(true);
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8'))).toMatchObject({ version: 1, markers: {} });
  });

  it('treats a structurally wrong file as corrupt', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ version: 1, created_at: 1, watermark: null, markers: { k: { state: 'weird', ts: 1 } } }));
    const store = new DedupeStore(file(), { retentionSeconds: DAY });
    store.load();
    expect(logs.some((e) => e.event === 'DEDUPE_STATE_CORRUPT')).toBe(true);
  });

  it('retries a rename that Windows refuses with EPERM/EBUSY, then succeeds', () => {
    let calls = 0;
    const restore = setRenameHooks({
      pause: () => {},
      rename: (from, to) => {
        calls++;
        if (calls <= 2) throw Object.assign(new Error('locked'), { code: calls === 1 ? 'EPERM' : 'EBUSY' });
        fs.renameSync(from, to);
      },
    });
    try {
      const store = new DedupeStore(file(), { retentionSeconds: DAY });
      store.load();
      expect(fs.existsSync(file())).toBe(true);
      expect(calls).toBe(3);
    } finally {
      restore();
    }
  });

  it('logs a save that keeps failing instead of throwing into the relay', () => {
    const restore = setRenameHooks({ pause: () => {}, rename: () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); } });
    try {
      const store = new DedupeStore(file(), { retentionSeconds: DAY });
      expect(() => store.load()).not.toThrow();
      expect(() => store.mark('k:1:0', 'relayed', 1)).not.toThrow();
      expect(store.state('k:1:0')).toBe('relayed');
      expect(logs.filter((e) => e.event === 'DEDUPE_SAVE_FAILED').length).toBeGreaterThan(0);
      expect(fs.readdirSync(path.dirname(file())).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
    } finally {
      restore();
    }
  });
});
