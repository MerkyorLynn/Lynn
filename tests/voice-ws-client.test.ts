import { describe, expect, it, vi } from 'vitest';
import {
  VOICE_FRAME,
  VoiceWsClient,
  decodeVoiceText,
  makeVoiceFrame,
  parseVoiceFrame,
  resolveVoiceWsUrl,
} from '../desktop/src/react/services/voice-ws-client';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  binaryType: BinaryType = 'blob';
  readyState = 0;
  sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }

  receive(data: ArrayBuffer) {
    this.onmessage?.({ data } as MessageEvent);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
}

class FakePcmStream {
  running = false;
  onPcm: ((pcm: Int16Array) => void) | null = null;
  start = vi.fn(async () => {
    this.running = true;
    return 16000;
  });
  stop = vi.fn(() => {
    this.running = false;
  });
  isRunning = vi.fn(() => this.running);
  emitPcm(pcm: Int16Array) {
    this.onPcm?.(pcm);
  }
}

class FakePcmPlayer {
  initialized = false;
  enqueued: Int16Array[] = [];
  init = vi.fn(async () => {
    this.initialized = true;
  });
  enqueue = vi.fn((pcm: Int16Array) => {
    this.enqueued.push(pcm);
  });
  flush = vi.fn(async () => {});
  destroy = vi.fn();
  isInitialized = vi.fn(() => this.initialized);
}

function openClient(client: VoiceWsClient) {
  const promise = client.connect();
  const ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  return promise.then(() => ws);
}

describe('voice-ws-client protocol helpers', () => {
  it('resolves localhost voice ws URL from a server port', () => {
    expect(resolveVoiceWsUrl(3456)).toBe('ws://127.0.0.1:3456/voice-ws');
    expect(resolveVoiceWsUrl(3456, 'chat')).toBe('ws://127.0.0.1:3456/voice-ws?mode=chat');
  });

  it('encodes and parses binary frames', () => {
    const frame = makeVoiceFrame(VOICE_FRAME.TRANSCRIPT_FINAL, 42, new TextEncoder().encode('你好'));
    const parsed = parseVoiceFrame(frame)!;
    expect(parsed.type).toBe(VOICE_FRAME.TRANSCRIPT_FINAL);
    expect(parsed.seq).toBe(42);
    expect(decodeVoiceText(parsed.payload)).toBe('你好');
  });
});

describe('VoiceWsClient', () => {
  it('connects with the server token as a websocket subprotocol', async () => {
    FakeWebSocket.instances = [];
    const client = new VoiceWsClient({
      port: 8123,
      token: 'secret',
      websocketCtor: FakeWebSocket,
    });

    const ws = await openClient(client);
    expect(ws.url).toBe('ws://127.0.0.1:8123/voice-ws');
    expect(ws.protocols).toEqual(['hana-v1', 'token.secret']);
    expect(ws.binaryType).toBe('arraybuffer');
  });

  it('streams PCM chunks and sends END_OF_TURN', async () => {
    FakeWebSocket.instances = [];
    const stream = new FakePcmStream();
    const player = new FakePcmPlayer();
    const client = new VoiceWsClient({
      url: 'ws://unit.test/voice-ws',
      websocketCtor: FakeWebSocket,
      pcmStreamFactory: (opts) => {
        stream.onPcm = opts.onPcm;
        return stream;
      },
      pcmPlayer: player,
    });

    const start = client.startListening();
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    await start;

    const pcm = new Int16Array(1600);
    pcm[0] = 123;
    stream.emitPcm(pcm);
    await client.endTurn();

    const first = parseVoiceFrame(ws.sent[0] as ArrayBuffer)!;
    const second = parseVoiceFrame(ws.sent[1] as ArrayBuffer)!;
    expect(first.type).toBe(VOICE_FRAME.PCM_AUDIO);
    expect(first.payload.byteLength).toBe(3200);
    expect(second.type).toBe(VOICE_FRAME.END_OF_TURN);
    expect(stream.stop).toHaveBeenCalledTimes(1);
  });

  it('plays incoming TTS PCM frames', async () => {
    FakeWebSocket.instances = [];
    const player = new FakePcmPlayer();
    const client = new VoiceWsClient({
      url: 'ws://unit.test/voice-ws',
      websocketCtor: FakeWebSocket,
      pcmPlayer: player,
    });
    const ws = await openClient(client);

    const pcm = new Int16Array([11, 22, 33]);
    ws.receive(makeVoiceFrame(VOICE_FRAME.PCM_TTS, 7, pcm));

    await vi.waitFor(() => expect(player.enqueue).toHaveBeenCalledTimes(1));
    expect(player.enqueued[0][0]).toBe(11);
    expect(player.enqueued[0][2]).toBe(33);
  });

  it('emits state, transcript, and emotion events', async () => {
    FakeWebSocket.instances = [];
    const onState = vi.fn();
    const onTranscriptFinal = vi.fn();
    const onAssistantReply = vi.fn();
    const onEmotion = vi.fn();
    const onHealth = vi.fn();
    const client = new VoiceWsClient({
      url: 'ws://unit.test/voice-ws',
      websocketCtor: FakeWebSocket,
      onState,
      onTranscriptFinal,
      onAssistantReply,
      onEmotion,
      onHealth,
    });
    const ws = await openClient(client);

    ws.receive(makeVoiceFrame(VOICE_FRAME.STATE_CHANGE, 1, new TextEncoder().encode('thinking')));
    ws.receive(makeVoiceFrame(VOICE_FRAME.TRANSCRIPT_FINAL, 2, new TextEncoder().encode('今天天气如何')));
    ws.receive(makeVoiceFrame(VOICE_FRAME.ASSISTANT_REPLY, 3, new TextEncoder().encode('我听到了。')));
    ws.receive(makeVoiceFrame(VOICE_FRAME.EMOTION, 4, new TextEncoder().encode(JSON.stringify({ label: 'neutral' }))));
    ws.receive(makeVoiceFrame(VOICE_FRAME.HEALTH_STATUS, 5, new TextEncoder().encode(JSON.stringify({
      ok: false,
      providers: { asr: { ok: false, fallbackOk: true } },
    }))));

    expect(onState).toHaveBeenCalledWith('thinking');
    expect(onTranscriptFinal).toHaveBeenCalledWith('今天天气如何');
    expect(onAssistantReply).toHaveBeenCalledWith('我听到了。');
    expect(onEmotion).toHaveBeenCalledWith({ label: 'neutral' });
    expect(onHealth).toHaveBeenCalledWith({
      ok: false,
      providers: { asr: { ok: false, fallbackOk: true } },
    });
  });

  it('stops capture when server-side VAD advances the turn to thinking', async () => {
    FakeWebSocket.instances = [];
    const stream = new FakePcmStream();
    const player = new FakePcmPlayer();
    const client = new VoiceWsClient({
      url: 'ws://unit.test/voice-ws',
      websocketCtor: FakeWebSocket,
      pcmPlayer: player,
      pcmStreamFactory: (opts) => {
        stream.onPcm = opts.onPcm;
        return stream;
      },
    });

    const start = client.startListening();
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    await start;
    expect(stream.running).toBe(true);

    ws.receive(makeVoiceFrame(VOICE_FRAME.STATE_CHANGE, 1, new TextEncoder().encode('thinking')));

    expect(stream.stop).toHaveBeenCalledTimes(1);
    expect(stream.running).toBe(false);
  });

  it('can keep capture running for future full-duplex modes', async () => {
    FakeWebSocket.instances = [];
    const stream = new FakePcmStream();
    const player = new FakePcmPlayer();
    const client = new VoiceWsClient({
      url: 'ws://unit.test/voice-ws',
      websocketCtor: FakeWebSocket,
      stopCaptureOnEndTurn: false,
      pcmPlayer: player,
      pcmStreamFactory: (opts) => {
        stream.onPcm = opts.onPcm;
        return stream;
      },
    });

    const start = client.startListening();
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    await start;

    ws.receive(makeVoiceFrame(VOICE_FRAME.STATE_CHANGE, 1, new TextEncoder().encode('thinking')));

    expect(stream.stop).not.toHaveBeenCalled();
    expect(stream.running).toBe(true);
  });

  it('sends INTERRUPT and flushes playback', async () => {
    FakeWebSocket.instances = [];
    const player = new FakePcmPlayer();
    const client = new VoiceWsClient({
      url: 'ws://unit.test/voice-ws',
      websocketCtor: FakeWebSocket,
      pcmPlayer: player,
    });
    const ws = await openClient(client);

    await client.interrupt();

    const frame = parseVoiceFrame(ws.sent[0] as ArrayBuffer)!;
    expect(frame.type).toBe(VOICE_FRAME.INTERRUPT);
    expect(player.flush).toHaveBeenCalledTimes(1);
  });

  it('sends TEXT_TURN for ASR fallback transcripts', async () => {
    FakeWebSocket.instances = [];
    const client = new VoiceWsClient({
      url: 'ws://unit.test/voice-ws',
      websocketCtor: FakeWebSocket,
    });
    const ws = await openClient(client);

    await client.sendTextTurn('Web Speech 转写');

    const frame = parseVoiceFrame(ws.sent[0] as ArrayBuffer)!;
    expect(frame.type).toBe(VOICE_FRAME.TEXT_TURN);
    expect(decodeVoiceText(frame.payload)).toBe('Web Speech 转写');
  });

  it('sends SPEAK_TEXT for chat-pipeline assistant replies', async () => {
    FakeWebSocket.instances = [];
    const client = new VoiceWsClient({
      url: 'ws://unit.test/voice-ws',
      websocketCtor: FakeWebSocket,
    });
    const ws = await openClient(client);

    await client.speakText('这是聊天框的最终回复。');

    const frame = parseVoiceFrame(ws.sent[0] as ArrayBuffer)!;
    expect(frame.type).toBe(VOICE_FRAME.SPEAK_TEXT);
    expect(decodeVoiceText(frame.payload)).toBe('这是聊天框的最终回复。');
  });

  it('reconnects a stale websocket before speaking a chat reply', async () => {
    FakeWebSocket.instances = [];
    const client = new VoiceWsClient({
      url: 'ws://unit.test/voice-ws',
      websocketCtor: FakeWebSocket,
    });
    const firstWs = await openClient(client);
    firstWs.close();

    const speak = client.speakText('重连后继续朗读。');
    const secondWs = FakeWebSocket.instances.at(-1)!;
    secondWs.open();
    await speak;

    expect(FakeWebSocket.instances).toHaveLength(2);
    const frame = parseVoiceFrame(secondWs.sent[0] as ArrayBuffer)!;
    expect(frame.type).toBe(VOICE_FRAME.SPEAK_TEXT);
    expect(decodeVoiceText(frame.payload)).toBe('重连后继续朗读。');
  });

  it('drops PCM frames quietly after the websocket closes', async () => {
    FakeWebSocket.instances = [];
    const client = new VoiceWsClient({
      url: 'ws://unit.test/voice-ws',
      websocketCtor: FakeWebSocket,
    });
    const ws = await openClient(client);
    ws.close();

    expect(() => client.sendPcm(new Int16Array(1600))).not.toThrow();
    expect(client.getStats().pcmFramesOut).toBe(0);
  });

  it('interrupts current speech before starting half-duplex capture', async () => {
    FakeWebSocket.instances = [];
    const stream = new FakePcmStream();
    const player = new FakePcmPlayer();
    const client = new VoiceWsClient({
      url: 'ws://unit.test/voice-ws',
      websocketCtor: FakeWebSocket,
      pcmStreamFactory: (opts) => {
        stream.onPcm = opts.onPcm;
        return stream;
      },
      pcmPlayer: player,
    });
    const ws = await openClient(client);
    ws.receive(makeVoiceFrame(VOICE_FRAME.STATE_CHANGE, 1, new TextEncoder().encode('speaking')));

    await client.startListening();

    const frame = parseVoiceFrame(ws.sent[0] as ArrayBuffer)!;
    expect(client.getState()).toBe('speaking');
    expect(frame.type).toBe(VOICE_FRAME.INTERRUPT);
    expect(player.flush).toHaveBeenCalledTimes(1);
    expect(stream.start).toHaveBeenCalledTimes(1);
  });
});
