// ffmpeg 도우미 서버의 핵심: 클립 오디오/프레임 스프라이트/미리보기 프록시/파형/mp4 내보내기.
// 결과는 캐시 폴더에 저장한다. helper.ts 가 이걸로 로컬 http 서버를 띄운다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export interface HelperConfig {
  mediaRoot: string; // 소스 파일 폴더 (파일 경로는 이 폴더 기준)
  cacheDir: string;
  exportsDir: string;
}

let ROOT = '';
let CACHE = '';
let EXPORTS = '';
const MEDIA_EXT = /\.(mp4|mkv|webm|mov|avi|m4v|m4a|mp3|wav|ogg|flac|aac|opus)$/i;
const FPS = 30;

/** 경로를 미디어 폴더 안으로만 (밖으로 나가는 경로는 거부) */
const resolveMedia = (p: string) => {
  const f = path.resolve(ROOT, p);
  if (f !== ROOT && !f.startsWith(ROOT + path.sep)) throw new Error('미디어 폴더 밖의 파일은 열 수 없어');
  return f;
};

function run(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} 실패 (${code}): ${Buffer.concat(err).toString().slice(-800)}`));
    });
  });
}
const ffmpeg = (args: string[]) => run('ffmpeg', ['-v', 'error', '-y', ...args]);

const durationCache = new Map<string, number>();
async function mediaDuration(file: string): Promise<number> {
  const st = await fsp.stat(file);
  const k = file + st.mtimeMs;
  if (!durationCache.has(k)) {
    const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    durationCache.set(k, parseFloat(out.toString()) || 0);
  }
  return durationCache.get(k)!;
}

const building = new Map<string, Promise<string>>();
async function cached(ext: string, parts: unknown, file: string, build: (out: string) => Promise<void>) {
  const st = await fsp.stat(file);
  const key = crypto.createHash('sha1').update(JSON.stringify(parts) + file + st.mtimeMs + st.size).digest('hex').slice(0, 20);
  const out = path.join(CACHE, key + ext);
  if (fs.existsSync(out)) return out;
  if (!building.has(out)) {
    const tmp = path.join(CACHE, `${key}.part${ext}`);
    building.set(
      out,
      build(tmp)
        .then(() => fsp.rename(tmp, out))
        .then(() => out)
        .finally(() => building.delete(out)),
    );
  }
  return building.get(out)!;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.wav': 'audio/wav', '.jpg': 'image/jpeg', '.json': 'application/json', '.png': 'image/png',
};

async function sendFile(req: IncomingMessage, res: ServerResponse, file: string) {
  const st = await fsp.stat(file);
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)!;
    const start = m[1] ? parseInt(m[1]) : 0;
    const end = m[2] ? parseInt(m[2]) : st.size - 1;
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  }
}

const json = (res: ServerResponse, data: unknown, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

async function walk(dir: string, acc: string[] = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc);
    else if (MEDIA_EXT.test(e.name)) acc.push(path.relative(ROOT, p));
  }
  return acc;
}

// ---- 내보내기 세션 ----
interface ExportJob { proc: ChildProcessWithoutNullStreams; out: string; err: string; done: Promise<number> }
const jobs = new Map<string, ExportJob>();

async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://x');
  const q = url.searchParams;
  const p = url.pathname;
  if (!p.startsWith('/api/')) return false;

  if (p === '/api/files') {
    return json(res, await walk(ROOT)), true;
  }

  if (p === '/api/ping') return json(res, { ok: true, kind: 'ffmpeg' }), true;

  if (p === '/api/upload' && req.method === 'POST') {
    // 브라우저에서 고른 파일을 미디어 폴더의 uploads/ 에 저장
    const name = path.basename(q.get('name') ?? '').replace(/[\\/:*?"<>|]/g, '_');
    if (!name || !MEDIA_EXT.test(name)) return json(res, { error: 'bad name' }, 400), true;
    const dir = path.join(ROOT, 'uploads');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, name), await readBody(req));
    return json(res, { file: path.join('uploads', name) }), true;
  }

  if (p === '/api/audio') {
    const file = resolveMedia(q.get('file')!);
    const inS = parseFloat(q.get('in') ?? '0');
    const outS = q.get('out') ? parseFloat(q.get('out')!) : null;
    const ch = q.get('ch') ?? '1';
    const out = await cached('.wav', ['audio', inS, outS, ch], file, (tmp) =>
      ffmpeg([
        '-ss', String(Math.max(0, inS)), ...(outS != null ? ['-t', String(Math.max(0.01, outS - inS))] : []),
        '-i', file, '-vn', '-ac', ch, '-ar', '44100', '-c:a', 'pcm_s16le', tmp,
      ]).then(() => undefined),
    );
    await sendFile(req, res, out);
    return true;
  }

  if (p === '/api/frames') {
    const file = resolveMedia(q.get('file')!);
    const inS = Math.max(0, parseFloat(q.get('in') ?? '0'));
    const dur = Math.min(6, Math.max(1 / FPS, parseFloat(q.get('dur') ?? '1')));
    const w = parseInt(q.get('w') ?? '480');
    const h = parseInt(q.get('h') ?? '320');
    const total = await mediaDuration(file);
    const count = Math.max(1, Math.min(Math.ceil(dur * FPS), Math.floor((total - inS) * FPS)));
    const cols = Math.min(count, 10);
    const rows = Math.ceil(count / cols);
    const out = await cached('.jpg', ['frames', inS, count, w, h], file, (tmp) =>
      ffmpeg([
        '-ss', String(inS), '-i', file, '-an',
        '-vf', `fps=${FPS},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},tile=${cols}x${rows}`,
        '-frames:v', '1', '-q:v', '4', tmp,
      ]).then(() => undefined),
    );
    return json(res, { url: `/api/cache/${path.basename(out)}`, cols, rows, count, fps: FPS, w, h }), true;
  }

  if (p.startsWith('/api/cache/')) {
    const f = path.join(CACHE, path.basename(p));
    if (!fs.existsSync(f)) return json(res, { error: 'not found' }, 404), true;
    await sendFile(req, res, f);
    return true;
  }

  if (p === '/api/proxy') {
    // <video>로 탐색하기 좋은 저해상도 mp4 (키프레임 촘촘하게)
    const file = resolveMedia(q.get('file')!);
    const out = await cached('.mp4', ['proxy2'], file, (tmp) =>
      ffmpeg([
        '-i', file, '-vf', 'scale=-2:360', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-g', '10',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', tmp,
      ]).then(() => undefined),
    );
    await sendFile(req, res, out);
    return true;
  }

  if (p === '/api/peaks') {
    const file = resolveMedia(q.get('file')!);
    const out = await cached('.json', ['peaks'], file, async (tmp) => {
      const raw = await ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
      const s = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
      const per = 80; // 100 peaks/sec
      const peaks: number[] = [];
      for (let i = 0; i < s.length; i += per) {
        let m = 0;
        for (let j = i; j < Math.min(i + per, s.length); j++) m = Math.max(m, Math.abs(s[j]));
        peaks.push(Math.round((m / 32768) * 255));
      }
      await fsp.writeFile(tmp, JSON.stringify({ rate: 100, peaks }));
    });
    await sendFile(req, res, out);
    return true;
  }

  if (p === '/api/export/begin' && req.method === 'POST') {
    const id = crypto.randomBytes(6).toString('hex');
    const name = (q.get('name') ?? 'export').replace(/[\\/:*?"<>|]/g, '_');
    const fps = q.get('fps') ?? '30';
    const wav = path.join(CACHE, `export-${id}.wav`);
    await fsp.writeFile(wav, await readBody(req));
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const out = path.join(EXPORTS, `${name}-${stamp}.mp4`);
    const proc = spawn('ffmpeg', [
      '-v', 'error', '-y', '-f', 'image2pipe', '-framerate', fps, '-i', '-', '-i', wav,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', out,
    ]);
    const job: ExportJob = {
      proc, out, err: '',
      done: new Promise((r) => proc.on('close', (c) => { fs.rm(wav, () => {}); r(c ?? 1); })),
    };
    proc.stderr.on('data', (d) => (job.err += d));
    jobs.set(id, job);
    return json(res, { id }), true;
  }
  if (p === '/api/export/frame' && req.method === 'POST') {
    const job = jobs.get(q.get('id')!);
    if (!job) return json(res, { error: 'no job' }, 404), true;
    const body = await readBody(req);
    if (!job.proc.stdin.write(body)) await new Promise((r) => job.proc.stdin.once('drain', r));
    return json(res, { ok: true }), true;
  }
  if (p === '/api/export/end' && req.method === 'POST') {
    const id = q.get('id')!;
    const job = jobs.get(id);
    if (!job) return json(res, { error: 'no job' }, 404), true;
    job.proc.stdin.end();
    const code = await job.done;
    jobs.delete(id);
    if (code !== 0) return json(res, { error: job.err.slice(-800) }, 500), true;
    return json(res, { path: path.relative(ROOT, job.out), url: `/api/exports/${encodeURIComponent(path.basename(job.out))}` }), true;
  }
  if (p.startsWith('/api/exports/')) {
    await sendFile(req, res, path.join(EXPORTS, path.basename(decodeURIComponent(p))));
    return true;
  }

  json(res, { error: 'unknown endpoint' }, 404);
  return true;
}

/** 설정으로 요청 처리기를 만든다. 처리 못 하면 false */
export function createHandler(cfg: HelperConfig) {
  ROOT = path.resolve(cfg.mediaRoot);
  CACHE = path.resolve(cfg.cacheDir);
  EXPORTS = path.resolve(cfg.exportsDir);
  for (const d of [ROOT, CACHE, EXPORTS]) fs.mkdirSync(d, { recursive: true });
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      return await handle(req, res);
    } catch (e) {
      console.error('[helper]', e);
      if (!res.headersSent) json(res, { error: String((e as Error)?.message ?? e) }, 500);
      else res.end();
      return true;
    }
  };
}
