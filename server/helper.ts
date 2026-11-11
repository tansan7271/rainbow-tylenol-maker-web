// ffmpeg 도우미 서버: 내 컴퓨터의 ffmpeg 로 프레임 추출·소리 자르기·mp4 내보내기를 빠르게.
// 실행: npm run helper -- --media ~/Videos/소스폴더 [--port 5318]
// 웹페이지(GitHub Pages 또는 로컬 개발 서버)가 이 서버를 찾으면 "ffmpeg 모드"를 고를 수 있다.
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHandler } from './core.ts';

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const home = (p: string) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

const port = parseInt(arg('port', '5318'));
const mediaRoot = path.resolve(home(arg('media', 'media')));
const dataDir = path.resolve(home(arg('data', '.helper')));

if (spawnSync('ffmpeg', ['-version']).status !== 0) {
  console.error('ffmpeg 를 찾을 수 없어. 먼저 설치해 줘 (macOS: brew install ffmpeg)');
  process.exit(1);
}

// 이 페이지들에서만 접근 허용 (다른 사이트가 내 파일을 읽지 못하게)
const ALLOWED = [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/, /^https:\/\/tansan7271\.github\.io$/];

const handle = createHandler({ mediaRoot, cacheDir: path.join(dataDir, 'cache'), exportsDir: path.join(dataDir, 'exports') });

http
  .createServer(async (req, res) => {
    const origin = req.headers.origin ?? '';
    if (origin) {
      if (!ALLOWED.some((r) => r.test(origin))) {
        res.writeHead(403).end('origin not allowed');
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '*',
        // 공개 웹페이지 → localhost 요청 허용 (크롬 Private Network Access)
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }
    if (!(await handle(req, res))) res.writeHead(404).end('not found');
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`ffmpeg 도우미: http://localhost:${port}`);
    console.log(`  소스 폴더: ${mediaRoot}`);
    console.log(`  캐시·내보내기: ${dataDir}`);
  });
