// 미디어 처리 두 가지 모드
//  - 브라우저 모드(기본): 사용자가 고른 파일을 브라우저 저장소(IndexedDB)에 두고, 소리는 WebAudio 로 자르고,
//    프레임은 <video> 로 뽑고, mp4 는 WebCodecs 로 만든다. 서버가 필요 없다.
//  - ffmpeg 모드: 내 컴퓨터에서 `npm run helper` 로 띄운 도우미 서버(ffmpeg)에 맡긴다. 빠르고 형식 제약이 적다.
// 파일은 문자열 이름(경로)으로 가리킨다. 브라우저 모드는 저장소 안 이름, ffmpeg 모드는 도우미 소스 폴더 기준 경로.
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

export interface Sprite {
  img: CanvasImageSource;
  cols: number;
  count: number;
  fps: number;
  w: number;
  h: number;
}

export interface ExportSession {
  addFrame(canvas: HTMLCanvasElement, index: number): Promise<void>;
  /** 끝내고 결과 파일(다운로드용 URL) */
  finish(): Promise<{ url: string; filename: string }>;
  cancel(): void;
}

export interface MediaBackend {
  kind: 'browser' | 'ffmpeg';
  listFiles(): Promise<string[]>;
  addFiles(files: File[]): Promise<string[]>;
  removeFile(name: string): Promise<void>;
  /** <video>/<audio> 재생용 주소 */
  mediaUrl(file: string): Promise<string>;
  audio(ctx: BaseAudioContext, file: string, inSec?: number, outSec?: number, ch?: number): Promise<AudioBuffer>;
  frames(file: string, inSec: number, dur: number, w: number, h: number): Promise<Sprite>;
  peaks(file: string): Promise<{ rate: number; peaks: number[] }>;
  beginExport(name: string, fps: number, width: number, height: number, audio: AudioBuffer): Promise<ExportSession>;
}

const FPS = 30;
export const HELPER_URL = 'http://localhost:5318';

// ---------------------------------------------------------------- 공통
export function encodeWav(buf: AudioBuffer): Blob {
  const ch = buf.numberOfChannels;
  const len = buf.length * ch * 2;
  const out = new DataView(new ArrayBuffer(44 + len));
  const w = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + len, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, buf.sampleRate, true); out.setUint32(28, buf.sampleRate * ch * 2, true);
  out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, len, true);
  const data = [...Array(ch)].map((_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < buf.length; i++)
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  return new Blob([out], { type: 'audio/wav' });
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** 버퍼의 [in, out] 구간을 ch 채널로 잘라 새 버퍼로 */
function sliceBuffer(ctx: BaseAudioContext, src: AudioBuffer, inSec = 0, outSec?: number, ch = 1) {
  const sr = src.sampleRate;
  const a = Math.max(0, Math.floor(inSec * sr));
  const b = Math.min(src.length, outSec != null ? Math.ceil(outSec * sr) : src.length);
  const len = Math.max(1, b - a);
  const out = ctx.createBuffer(ch, len, sr);
  for (let c = 0; c < ch; c++) {
    const dst = out.getChannelData(c);
    if (ch === 1 && src.numberOfChannels > 1) {
      for (let k = 0; k < src.numberOfChannels; k++) {
        const s = src.getChannelData(k);
        for (let i = 0; i < len; i++) dst[i] += s[a + i] / src.numberOfChannels;
      }
    } else dst.set(src.getChannelData(Math.min(c, src.numberOfChannels - 1)).subarray(a, a + len));
  }
  return out;
}

// ---------------------------------------------------------------- 브라우저 모드
const DB = 'rtm-media';
function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const r = fn(d.transaction('files', mode).objectStore('files'));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export class BrowserBackend implements MediaBackend {
  kind = 'browser' as const;
  private urls = new Map<string, string>();
  private decoded = new Map<string, Promise<AudioBuffer>>();
  private sprites = new Map<string, Promise<Sprite>>();

  async listFiles() {
    return ((await idb('readonly', (s) => s.getAllKeys())) as string[]).sort();
  }
  async addFiles(files: File[]) {
    const names: string[] = [];
    for (const f of files) {
      await idb('readwrite', (s) => s.put(f, f.name));
      this.urls.delete(f.name);
      this.decoded.delete(f.name);
      names.push(f.name);
    }
    return names;
  }
  async removeFile(name: string) {
    await idb('readwrite', (s) => s.delete(name));
    const u = this.urls.get(name);
    if (u) URL.revokeObjectURL(u);
    this.urls.delete(name);
    this.decoded.delete(name);
  }
  private async blob(file: string) {
    const b = (await idb('readonly', (s) => s.get(file))) as Blob | undefined;
    if (!b) throw new Error(`“${file}” 파일이 브라우저에 없어. 소스 파일을 다시 넣어 줘`);
    return b;
  }
  async mediaUrl(file: string) {
    if (!this.urls.has(file)) this.urls.set(file, URL.createObjectURL(await this.blob(file)));
    return this.urls.get(file)!;
  }
  /** 파일 전체 소리를 한 번만 풀어 둠 */
  private full(ctx: BaseAudioContext, file: string) {
    if (!this.decoded.has(file)) {
      const p = this.blob(file).then(async (b) => ctx.decodeAudioData(await b.arrayBuffer()));
      p.catch(() => this.decoded.delete(file));
      this.decoded.set(file, p);
    }
    return this.decoded.get(file)!;
  }
  async audio(ctx: BaseAudioContext, file: string, inSec?: number, outSec?: number, ch = 1) {
    return sliceBuffer(ctx, await this.full(ctx, file), inSec, outSec, ch);
  }
  frames(file: string, inSec: number, dur: number, w: number, h: number) {
    const key = [file, inSec, dur, w, h].join('|');
    if (!this.sprites.has(key)) {
      const p = this.grab(file, inSec, dur, w, h);
      p.catch(() => this.sprites.delete(key));
      this.sprites.set(key, p);
    }
    return this.sprites.get(key)!;
  }
  /** <video> 를 프레임마다 옮겨 가며 그려서 한 장짜리 스프라이트로 */
  private async grab(file: string, inSec: number, dur: number, w: number, h: number): Promise<Sprite> {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = await this.mediaUrl(file);
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new Error(`“${file}” 영상을 열 수 없어 (브라우저가 지원하지 않는 형식일 수 있어 — mp4/webm 권장, 아니면 ffmpeg 모드)`));
    });
    const count = Math.max(1, Math.min(Math.ceil(dur * FPS), Math.floor((v.duration - inSec) * FPS)));
    const cols = Math.min(count, 10);
    const rows = Math.ceil(count / cols);
    const c = document.createElement('canvas');
    c.width = cols * w;
    c.height = rows * h;
    const g = c.getContext('2d')!;
    // 화면 비율 맞춰 가운데 자르기 (cover)
    const s = Math.max(w / v.videoWidth, h / v.videoHeight);
    const sw = w / s;
    const sh = h / s;
    const sx = (v.videoWidth - sw) / 2;
    const sy = (v.videoHeight - sh) / 2;
    for (let i = 0; i < count; i++) {
      await new Promise<void>((res) => {
        v.onseeked = () => res();
        v.currentTime = inSec + (i + 0.5) / FPS;
      });
      g.drawImage(v, sx, sy, sw, sh, (i % cols) * w, Math.floor(i / cols) * h, w, h);
    }
    v.removeAttribute('src');
    v.load();
    return { img: c, cols, count, fps: FPS, w, h };
  }
  async peaks(file: string) {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const b = await this.full(ctx, file);
    const per = Math.floor(b.sampleRate / 100);
    const d = sliceBuffer(ctx, b, 0, undefined, 1).getChannelData(0);
    const peaks: number[] = [];
    for (let i = 0; i < d.length; i += per) {
      let m = 0;
      for (let j = i; j < Math.min(i + per, d.length); j++) m = Math.max(m, Math.abs(d[j]));
      peaks.push(Math.round(Math.min(1, m) * 255));
    }
    return { rate: 100, peaks };
  }
  async beginExport(name: string, fps: number, width: number, height: number, audio: AudioBuffer): Promise<ExportSession> {
    if (!('VideoEncoder' in window) || !('AudioEncoder' in window))
      throw new Error('이 브라우저는 영상 인코딩(WebCodecs)을 지원하지 않아. 크롬/엣지/최신 사파리를 쓰거나 ffmpeg 모드를 써 줘');
    const vcfg: VideoEncoderConfig = { codec: 'avc1.640028', width, height, bitrate: 8_000_000, framerate: fps };
    if (!(await VideoEncoder.isConfigSupported(vcfg)).supported) vcfg.codec = 'avc1.42001f';
    const sr = audio.sampleRate;
    const chs = audio.numberOfChannels;
    let acodec: 'aac' | 'opus' = 'aac';
    let acfg: AudioEncoderConfig = { codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: chs, bitrate: 192_000 };
    if (!(await AudioEncoder.isConfigSupported(acfg)).supported) {
      acodec = 'opus';
      acfg = { codec: 'opus', sampleRate: 48000, numberOfChannels: chs, bitrate: 192_000 };
    }
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width, height, frameRate: fps },
      audio: { codec: acodec, sampleRate: acfg.sampleRate, numberOfChannels: chs },
      fastStart: 'in-memory',
    });
    let failed: unknown = null;
    const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => (failed = e) });
    venc.configure(vcfg);
    // 소리: 통째로 한 번에 인코딩 (opus 면 48kHz 로 다시 맞춤)
    let abuf = audio;
    if (acfg.sampleRate !== sr) {
      const off = new OfflineAudioContext(chs, Math.ceil(audio.duration * acfg.sampleRate), acfg.sampleRate);
      const s = off.createBufferSource();
      s.buffer = audio;
      s.connect(off.destination);
      s.start();
      abuf = await off.startRendering();
    }
    const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => (failed = e) });
    aenc.configure(acfg);
    const CH = 4096;
    for (let i = 0; i < abuf.length; i += CH) {
      const n = Math.min(CH, abuf.length - i);
      const planar = new Float32Array(n * chs);
      for (let c = 0; c < chs; c++) planar.set(abuf.getChannelData(c).subarray(i, i + n), c * n);
      aenc.encode(new AudioData({ format: 'f32-planar', sampleRate: acfg.sampleRate, numberOfFrames: n, numberOfChannels: chs, timestamp: Math.round((i / acfg.sampleRate) * 1e6), data: planar }));
    }
    let cancelled = false;
    return {
      async addFrame(canvas, index) {
        if (failed) throw failed;
        while (venc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
        const f = new VideoFrame(canvas, { timestamp: Math.round((index / fps) * 1e6), duration: Math.round(1e6 / fps) });
        venc.encode(f, { keyFrame: index % (fps * 2) === 0 });
        f.close();
      },
      async finish() {
        await venc.flush();
        await aenc.flush();
        if (failed) throw failed;
        muxer.finalize();
        const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
        return { url: URL.createObjectURL(blob), filename: `${name}-${stamp()}.mp4` };
      },
      cancel() {
        if (cancelled) return;
        cancelled = true;
        try { venc.close(); aenc.close(); } catch { /* 이미 닫힘 */ }
      },
    };
  }
}

// ---------------------------------------------------------------- ffmpeg 모드 (도우미 서버)
export class FfmpegBackend implements MediaBackend {
  kind = 'ffmpeg' as const;
  private audioCache = new Map<string, Promise<AudioBuffer>>();
  private spriteCache = new Map<string, Promise<Sprite>>();
  constructor(private base = HELPER_URL) {}

  private async get(path: string) {
    const r = await fetch(this.base + path);
    if (!r.ok) throw new Error(await r.text());
    return r;
  }
  async listFiles() {
    return (await (await this.get('/api/files')).json()) as string[];
  }
  async addFiles(files: File[]) {
    const out: string[] = [];
    for (const f of files) {
      const r = await fetch(`${this.base}/api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
      if (!r.ok) throw new Error(await r.text());
      out.push((await r.json()).file);
    }
    return out;
  }
  async removeFile() {
    throw new Error('ffmpeg 모드에선 도우미의 소스 폴더에서 직접 지워 줘');
  }
  async mediaUrl(file: string) {
    return `${this.base}/api/proxy?file=${encodeURIComponent(file)}`;
  }
  audio(ctx: BaseAudioContext, file: string, inSec?: number, outSec?: number, ch = 1) {
    const key = [file, inSec, outSec, ch].join('|');
    if (!this.audioCache.has(key)) {
      const qs = `file=${encodeURIComponent(file)}&ch=${ch}` + (inSec != null ? `&in=${inSec}` : '') + (outSec != null ? `&out=${outSec}` : '');
      const p = this.get(`/api/audio?${qs}`).then(async (r) => ctx.decodeAudioData(await r.arrayBuffer()));
      p.catch(() => this.audioCache.delete(key));
      this.audioCache.set(key, p);
    }
    return this.audioCache.get(key)!;
  }
  frames(file: string, inSec: number, dur: number, w: number, h: number) {
    const key = [file, inSec, dur, w, h].join('|');
    if (!this.spriteCache.has(key)) {
      const p = (async () => {
        const meta = await (await this.get(`/api/frames?file=${encodeURIComponent(file)}&in=${inSec}&dur=${dur}&w=${w}&h=${h}`)).json();
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = this.base + meta.url;
        await img.decode();
        return { img, cols: meta.cols, count: meta.count, fps: meta.fps, w: meta.w, h: meta.h } as Sprite;
      })();
      p.catch(() => this.spriteCache.delete(key));
      this.spriteCache.set(key, p);
    }
    return this.spriteCache.get(key)!;
  }
  async peaks(file: string) {
    return (await this.get(`/api/peaks?file=${encodeURIComponent(file)}`)).json();
  }
  async beginExport(name: string, fps: number, _w: number, _h: number, audio: AudioBuffer): Promise<ExportSession> {
    const r = await fetch(`${this.base}/api/export/begin?name=${encodeURIComponent(name)}&fps=${fps}`, { method: 'POST', body: encodeWav(audio) });
    if (!r.ok) throw new Error(await r.text());
    const { id } = await r.json();
    const base = this.base;
    return {
      async addFrame(canvas) {
        const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', 0.92));
        await fetch(`${base}/api/export/frame?id=${id}`, { method: 'POST', body: blob });
      },
      async finish() {
        const e = await (await fetch(`${base}/api/export/end?id=${id}`, { method: 'POST' })).json();
        if (e.error) throw new Error(e.error);
        return { url: base + e.url, filename: e.path.split('/').pop() };
      },
      cancel() {
        fetch(`${base}/api/export/end?id=${id}`, { method: 'POST' }).catch(() => {});
      },
    };
  }
}

// ---------------------------------------------------------------- 모드 고르기
export type ModePref = 'auto' | 'browser' | 'ffmpeg';
export const modePref = (): ModePref => (localStorage.getItem('rtm.mode') as ModePref) || 'auto';
export const setModePref = (m: ModePref) => localStorage.setItem('rtm.mode', m);

export async function helperAvailable() {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 600);
    const r = await fetch(HELPER_URL + '/api/ping', { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

export let backend: MediaBackend = new BrowserBackend();
/** 설정과 도우미 유무로 모드를 정함. 반환: 실제 모드, 도우미 있음 여부 */
export async function chooseBackend() {
  const has = await helperAvailable();
  const pref = modePref();
  backend = pref === 'browser' || !has ? new BrowserBackend() : new FfmpegBackend();
  return { kind: backend.kind, helper: has };
}
