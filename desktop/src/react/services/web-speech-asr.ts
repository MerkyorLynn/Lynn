/**
 * Web Speech API fallback ASR for Jarvis Runtime.
 *
 * This is intentionally only a transcript source. The final text is sent back
 * through VoiceWsClient.TEXT_TURN so Brain/TTS/tool behavior stays server-side.
 */

type SpeechRecognitionAlternativeLike = {
  transcript?: string;
};

type SpeechRecognitionResultLike = {
  isFinal?: boolean;
  [index: number]: SpeechRecognitionAlternativeLike | undefined;
};

type SpeechRecognitionResultListLike = {
  length: number;
  [index: number]: SpeechRecognitionResultLike | undefined;
};

type SpeechRecognitionEventLike = {
  resultIndex?: number;
  results?: SpeechRecognitionResultListLike;
};

type SpeechRecognitionErrorEventLike = {
  error?: string;
  message?: string;
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export interface WebSpeechAsrOptions {
  lang?: string;
  continuous?: boolean;
  interimResults?: boolean;
  maxAlternatives?: number;
  finishTimeoutMs?: number;
  windowRef?: Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (err: Error) => void;
}

export function getWebSpeechRecognitionCtor(win = getDefaultWindow()): SpeechRecognitionCtor | null {
  if (!win) return null;
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

export function isWebSpeechAsrAvailable(win = getDefaultWindow()): boolean {
  return !!getWebSpeechRecognitionCtor(win);
}

function getDefaultWindow(): WebSpeechAsrOptions['windowRef'] | undefined {
  return typeof window !== 'undefined' ? window as WebSpeechAsrOptions['windowRef'] : undefined;
}

function normalizeError(event: SpeechRecognitionErrorEventLike): Error {
  const code = event?.error ? ` (${event.error})` : '';
  return new Error(event?.message || `Web Speech ASR failed${code}`);
}

export class WebSpeechAsr {
  private opts: Required<Pick<WebSpeechAsrOptions, 'lang' | 'continuous' | 'interimResults' | 'maxAlternatives' | 'finishTimeoutMs'>>;
  private windowRef?: WebSpeechAsrOptions['windowRef'];
  private recognition: SpeechRecognitionLike | null = null;
  private running = false;
  private finalSegments: string[] = [];
  private partial = '';
  private finishResolver: ((text: string) => void) | null = null;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private onPartial?: (text: string) => void;
  private onFinal?: (text: string) => void;
  private onError?: (err: Error) => void;

  constructor(opts: WebSpeechAsrOptions = {}) {
    this.opts = {
      lang: opts.lang || 'zh-CN',
      continuous: opts.continuous ?? false,
      interimResults: opts.interimResults ?? true,
      maxAlternatives: opts.maxAlternatives || 1,
      finishTimeoutMs: opts.finishTimeoutMs || 1200,
    };
    this.windowRef = opts.windowRef;
    this.onPartial = opts.onPartial;
    this.onFinal = opts.onFinal;
    this.onError = opts.onError;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const Ctor = getWebSpeechRecognitionCtor(this.windowRef);
    if (!Ctor) throw new Error('Web Speech ASR is unavailable');

    this.finalSegments = [];
    this.partial = '';
    const recognition = new Ctor();
    recognition.lang = this.opts.lang;
    recognition.continuous = this.opts.continuous;
    recognition.interimResults = this.opts.interimResults;
    recognition.maxAlternatives = this.opts.maxAlternatives;
    recognition.onresult = (event) => this.handleResult(event);
    recognition.onerror = (event) => {
      const err = normalizeError(event);
      this.onError?.(err);
      this.resolveFinish(this.getTranscript());
    };
    recognition.onend = () => {
      this.running = false;
      this.resolveFinish(this.getTranscript());
    };
    this.recognition = recognition;
    recognition.start();
    this.running = true;
  }

  finish(timeoutMs = this.opts.finishTimeoutMs): Promise<string> {
    if (!this.recognition || !this.running) return Promise.resolve(this.getTranscript());
    return new Promise((resolve) => {
      this.finishResolver = resolve;
      this.finishTimer = setTimeout(() => this.resolveFinish(this.getTranscript()), timeoutMs);
      try {
        this.recognition?.stop();
      } catch {
        this.resolveFinish(this.getTranscript());
      }
    });
  }

  abort(): void {
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = null;
    this.finishResolver = null;
    this.running = false;
    try {
      this.recognition?.abort();
    } catch {}
    this.recognition = null;
    this.partial = '';
  }

  isRunning(): boolean {
    return this.running;
  }

  getTranscript(): string {
    return [...this.finalSegments, this.partial].join(' ').replace(/\s+/g, ' ').trim();
  }

  private handleResult(event: SpeechRecognitionEventLike): void {
    const results = event.results;
    if (!results) return;
    let interim = '';
    const start = Math.max(0, event.resultIndex || 0);
    for (let i = start; i < results.length; i += 1) {
      const result = results[i];
      const text = String(result?.[0]?.transcript || '').trim();
      if (!text) continue;
      if (result?.isFinal) {
        this.finalSegments.push(text);
        this.partial = '';
        this.onFinal?.(this.getTranscript());
      } else {
        interim = text;
      }
    }
    this.partial = interim;
    this.onPartial?.(this.getTranscript());
  }

  private resolveFinish(text: string): void {
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = null;
    const resolve = this.finishResolver;
    this.finishResolver = null;
    this.running = false;
    if (resolve) resolve(text);
  }
}
