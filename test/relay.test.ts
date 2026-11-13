import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DedupeStore } from '../src/dedupe.js';
import type { SendOutcome } from '../src/http.js';
import { Relay, type Sink } from '../src/relay.js';
import { MessageRecorder } from '../src/sinks/jsonl.js';
import { captureLogs, makeDm, useTempDir } from './helpers.js';

class RecordingSink implements Sink {
  readonly received: string[] = [];
  constructor(readonly name: string, private readonly behave: () => Promise<SendOutcome>) {}
  async send(dm: { msgId: string }): Promise<SendOutcome> {
    this.received.push(dm.msgId);
    return this.behave();
  }
}

const ok = (): Promise<SendOutcome> => Promise.resolve({ ok: true, attempts: 1 });

describe('Relay fan-out', () => {
  const tmp = useTempDir();
  const logs = captureLogs();

  function setup(sinks: Sink[], opts: { paused?: () => boolean } = {}) {
    const store = new DedupeStore(path.join(tmp(), 'main', 'relayed.json'), { retentionSeconds: 30 * 86_400 });
    store.load();
    const messagesFile = path.join(tmp(), 'messages.jsonl');
    const relay = new Relay({
      stores: { main: store }, recorder: new MessageRecorder(messagesFile), sinks,
      isPaused: opts.paused ?? (() => false), sleep: () => new Promise((r) => setTimeout(r, 1)), pausePollMs: 1,
    });
    const records = (): Array<Record<string, unknown>> => (fs.existsSync(messagesFile)
      ? fs.readFileSync(messagesFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : []);
    return { store, relay, records };
  }

  it('isolates each sink: a throw and a failure do not stop the others or the next DM', async () => {
    const throwing = new RecordingSink('throws', () => { throw new Error('boom https://discord.com/api/webhooks/1/secret'); });
    const failing = new RecordingSink('fails', () => Promise.resolve({ ok: false, attempts: 3, status: 503, error: 'HTTP 503' }));
    const good = new RecordingSink('good', ok);
    const { relay, store, records } = setup([throwing, failing, good]);
    const first = makeDm();
    const second = makeDm({ ordinal: 1, text: 'second' });
    expect(relay.enqueue(first)).toBe('queued');
    expect(relay.enqueue(second)).toBe('queued');
    await relay.drain();

    expect(good.received).toEqual([first.msgId, second.msgId]);
    expect(throwing.received).toHaveLength(2);
    expect(failing.received).toHaveLength(2);
    expect(store.state(first.key)).toBe('relayed');
    expect(store.state(second.key)).toBe('relayed');
    expect(logs.filter((e) => e.event === 'SINK_FAILED')).toHaveLength(4);
    const results = records().filter((r) => r['type'] === 'relay_result');
    expect(results).toHaveLength(2);
    expect((results[0]!['results'] as Record<string, SendOutcome>)['good']!.ok).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('webhooks/1/secret');
  });

  it('records the DM verbatim before any sink runs, and keeps the body out of ops logs', async () => {
    let recordedFirst = false;
    const { relay, records } = setup([new RecordingSink('check', async () => {
      recordedFirst = records().some((r) => r['type'] === 'dm');
      return { ok: true, attempts: 1 };
    })]);
    const dm = makeDm({ text: 'line one\nline "two" 🔥' });
    relay.enqueue(dm);
    await relay.drain();
    expect(recordedFirst).toBe(true);
    const dmRecord = records().find((r) => r['type'] === 'dm')!;
    expect(dmRecord['text']).toBe('line one\nline "two" 🔥');
    expect(dmRecord['sender_steam_id']).toBe(dm.senderSteamId);
    expect(JSON.stringify(logs)).not.toContain('line one');
  });

  it('never relays the same message twice, in one run or after a restart', async () => {
    const good = new RecordingSink('good', ok);
    const { relay } = setup([good]);
    const dm = makeDm();
    expect(relay.enqueue(dm)).toBe('queued');
    expect(relay.enqueue({ ...dm, source: 'backfill' })).toBe('duplicate');
    await relay.drain();
    expect(relay.enqueue(dm)).toBe('duplicate');

    const restartedSink = new RecordingSink('good', ok);
    const restarted = setup([restartedSink]);
    expect(restarted.relay.enqueue({ ...dm, source: 'backfill' })).toBe('duplicate');
    await restarted.relay.drain();
    expect(good.received).toHaveLength(1);
    expect(restartedSink.received).toHaveLength(0);
  });

  it('marks relayed even when every sink failed, so a restart does not double-post to the healthy one', async () => {
    const { relay, store } = setup([new RecordingSink('down', () => Promise.resolve({ ok: false, attempts: 3, error: 'timeout' }))]);
    const dm = makeDm();
    relay.enqueue(dm);
    await relay.drain();
    expect(store.state(dm.key)).toBe('relayed');
  });

  it('PAUSE holds network delivery but still records locally, then drains in order', async () => {
    let paused = true;
    const good = new RecordingSink('good', ok);
    const { relay, store, records } = setup([good], { paused: () => paused });
    const a = makeDm();
    const b = makeDm({ ordinal: 1 });
    relay.enqueue(a);
    relay.enqueue(b);
    await new Promise((r) => setTimeout(r, 20));
    expect(good.received).toEqual([]);
    expect(store.state(a.key)).toBe('recorded');
    expect(records().filter((r) => r['type'] === 'dm')).toHaveLength(1);
    paused = false;
    await relay.drain();
    expect(good.received).toEqual([a.msgId, b.msgId]);
  });

  it('a recorded-but-undelivered DM from a previous run is delivered once when seen again', async () => {
    const first = setup([], { paused: () => true });
    const dm = makeDm();
    first.relay.enqueue(dm);
    await new Promise((r) => setTimeout(r, 10));
    await first.relay.stop(50);
    expect(first.store.state(dm.key)).toBe('recorded');

    const good = new RecordingSink('good', ok);
    const second = setup([good]);
    expect(second.relay.enqueue({ ...dm, source: 'backfill' })).toBe('queued');
    await second.relay.drain();
    expect(good.received).toEqual([dm.msgId]);
    expect(second.records().filter((r) => r['type'] === 'dm')).toHaveLength(1);
  });

  it('a sink that hangs cannot block enqueue, and stop() gives up after its timeout but records what is queued', async () => {
    const hang = new RecordingSink('hang', () => new Promise<SendOutcome>(() => {}));
    const { relay, store } = setup([hang]);
    const a = makeDm();
    const b = makeDm({ ordinal: 1 });
    expect(relay.enqueue(a)).toBe('queued');
    expect(relay.enqueue(b)).toBe('queued');
    await new Promise((r) => setTimeout(r, 10));
    expect(await relay.stop(20)).toBe(false);
    expect(store.state(b.key)).toBe('recorded');
    expect(relay.enqueue(makeDm({ ordinal: 2 }))).toBe('overflow');
  });

  it('resolves the sender name lazily, and a failing lookup does not drop the DM', async () => {
    const good = new RecordingSink('good', ok);
    const { relay, records } = setup([good]);
    relay.enqueue(makeDm({ senderName: null }), async () => 'Looked Up');
    relay.enqueue(makeDm({ senderName: null, ordinal: 1 }), async () => { throw new Error('steam down'); });
    await relay.drain();
    const names = records().filter((r) => r['type'] === 'dm').map((r) => r['sender_name']);
    expect(names).toEqual(['Looked Up', null]);
    expect(good.received).toHaveLength(2);
  });
});
