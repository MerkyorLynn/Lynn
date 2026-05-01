import { describe, expect, it, vi } from 'vitest';
import {
  WebSpeechAsr,
  getWebSpeechRecognitionCtor,
  isWebSpeechAsrAvailable,
} from '../desktop/src/react/services/web-speech-asr';

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => {
    this.onend?.();
  });
  abort = vi.fn();

  constructor() {
    FakeRecognition.instances.push(this);
  }

  emitResult(results: Array<{ transcript: string; isFinal?: boolean }>) {
    this.onresult?.({
      resultIndex: 0,
      results: Object.assign(
        results.map((r) => Object.assign({ 0: { transcript: r.transcript }, isFinal: !!r.isFinal })),
        { length: results.length },
      ),
    });
  }
}

function makeWindowRef() {
  return { webkitSpeechRecognition: FakeRecognition as any } as any;
}

describe('Web Speech ASR fallback', () => {
  it('detects browser support from SpeechRecognition constructors', () => {
    expect(getWebSpeechRecognitionCtor({} as any)).toBeNull();
    expect(isWebSpeechAsrAvailable(makeWindowRef())).toBe(true);
  });

  it('collects partial and final transcripts', async () => {
    FakeRecognition.instances = [];
    const partials: string[] = [];
    const finals: string[] = [];
    const asr = new WebSpeechAsr({
      windowRef: makeWindowRef(),
      onPartial: (text) => partials.push(text),
      onFinal: (text) => finals.push(text),
    });

    await asr.start();
    const recognition = FakeRecognition.instances[0];
    expect(recognition.lang).toBe('zh-CN');
    expect(recognition.interimResults).toBe(true);
    expect(recognition.start).toHaveBeenCalledTimes(1);

    recognition.emitResult([{ transcript: '你好', isFinal: false }]);
    recognition.emitResult([{ transcript: '你好 Lynn', isFinal: true }]);

    expect(partials.at(-1)).toBe('你好 Lynn');
    expect(finals).toEqual(['你好 Lynn']);
    expect(asr.getTranscript()).toBe('你好 Lynn');
  });

  it('finish stops recognition and returns the best transcript', async () => {
    FakeRecognition.instances = [];
    const asr = new WebSpeechAsr({ windowRef: makeWindowRef() });
    await asr.start();
    const recognition = FakeRecognition.instances[0];
    recognition.emitResult([{ transcript: '最终文本', isFinal: false }]);

    await expect(asr.finish()).resolves.toBe('最终文本');
    expect(recognition.stop).toHaveBeenCalledTimes(1);
    expect(asr.isRunning()).toBe(false);
  });

  it('reports recognition errors without throwing from the event handler', async () => {
    FakeRecognition.instances = [];
    const onError = vi.fn();
    const asr = new WebSpeechAsr({ windowRef: makeWindowRef(), onError });
    await asr.start();
    FakeRecognition.instances[0].onerror?.({ error: 'not-allowed', message: 'permission denied' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'permission denied' }));
  });
});
