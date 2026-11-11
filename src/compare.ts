// 비교 화면: 우리 버전과 유튜브 원본을 같은 타이밍으로 나란히 재생 (편집 기능 없음).
// 유튜브는 프레임 단위로 정확히 맞출 수 없어서 ±1~2프레임 정도 어긋날 수 있다.
import { createBuses, scheduleAll, type Mix } from './audio';
import { backend, chooseBackend } from './backend';
import { fetchAudio, loadAllAssets, type SlotAssets } from './media';
import { getTemplate, listProjects, listTemplates, loadProject } from './store';
import { VideoSync, YouTubeSync, type OrigPlayer } from './youtube';
import { pickFiles } from './slots';
import { stealth } from './stealth';
import { beatToSec, secToBeat, type Template } from './types';
import { Renderer } from './visual';
import { letter } from './stealth';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const actx = new AudioContext({ sampleRate: 44100 });
const vol = { songOn: true, synthOn: true, synth: 1, ...JSON.parse(localStorage.getItem('rtm.vol') ?? '{}') };
let buses = createBuses(actx, 0.8, vol.synth);
const mix: Mix = { muted: new Set(), solo: null, override: null };

let tpl: Template;
let assets = new Map<string, SlotAssets>();
let song: AudioBuffer | null = null;
let renderer: Renderer;
const canvas = $<HTMLCanvasElement>('ours');
const g = canvas.getContext('2d')!;
let yt: OrigPlayer | null = null; // 원본: 유튜브 또는 내 파일
let ytId = '';
let wallClock: { at: number; song: number } | null = null; // 우리 소리를 안 틀 때의 시계

let frame = 0; // 현재 프레임 (정지 상태 기준)
let playing = false;
let nodes: AudioScheduledSourceNode[] = [];
let audioClock: { ctx: number; song: number } | null = null; // 우리 소리가 마스터일 때
let markIn: number | null = null;
let markOut: number | null = null;

const fps = () => tpl.video.fps;
const t0 = () => beatToSec(tpl, tpl.range.start);
const total = () => Math.ceil((beatToSec(tpl, tpl.range.end) - t0()) * fps());
const songAt = (f: number) => t0() + f / fps();
// 원본 시간 = 원곡 시간 + lag (+ 내 파일이 유튜브와 앞부분이 다르면 오프셋으로 보정)
const offset = () => +($<HTMLInputElement>('origOffset').value || 0);
const lag = () => (tpl.youtube?.lag ?? 0) + offset();
// 소리 설정: 우리/원본 각각 켜기 + 볼륨 (둘 다 켜면 겹쳐서 들림)
const snd = { oursOn: false, oursVol: 1, origOn: true, origVol: 1, ...JSON.parse(localStorage.getItem('rtm.cmp.snd') ?? '{}') };
function applySound() {
  $<HTMLInputElement>('oursOn').checked = snd.oursOn;
  $<HTMLInputElement>('oursVol').value = String(snd.oursVol);
  $<HTMLInputElement>('origOn').checked = snd.origOn;
  $<HTMLInputElement>('origVol').value = String(snd.origVol);
  yt?.setVolume(snd.origVol, !snd.origOn);
  if (tpl) {
    buses.song.gain.setTargetAtTime((vol.songOn ? tpl.song.gain : 0) * snd.oursVol, actx.currentTime, 0.015);
    buses.synth.gain.setTargetAtTime((vol.synthOn ? vol.synth : 0) * snd.oursVol, actx.currentTime, 0.015);
  }
  localStorage.setItem('rtm.cmp.snd', JSON.stringify(snd));
}
const restart = () => { if (playing) { stop(); play(); } };
$<HTMLInputElement>('oursOn').onchange = (e) => { snd.oursOn = (e.target as HTMLInputElement).checked; applySound(); restart(); };
$<HTMLInputElement>('oursVol').oninput = (e) => { snd.oursVol = +(e.target as HTMLInputElement).value; applySound(); };
$<HTMLInputElement>('origOn').onchange = (e) => { snd.origOn = (e.target as HTMLInputElement).checked; applySound(); };
$<HTMLInputElement>('origVol').oninput = (e) => { snd.origVol = +(e.target as HTMLInputElement).value; applySound(); };
const speed = () => +$<HTMLSelectElement>('speed').value;

function toast(t: string) {
  $('toast').textContent = t;
  setTimeout(() => ($('toast').textContent = ''), 1500);
}

// ---------------- 불러오기 ----------------
async function load(kind: string, name: string) {
  stop();
  tpl = kind === 'template' ? getTemplate(name) : loadProject(name);
  canvas.width = tpl.video.width;
  canvas.height = tpl.video.height;
  applySound();
  const f = tpl.song.file;
  const songP = f && !f.startsWith('@') ? fetchAudio(actx, f, undefined, undefined, 2).catch(() => null) : Promise.resolve(null);
  assets = await loadAllAssets(actx, tpl);
  song = await songP;
  renderer ? renderer.setData(tpl, assets) : (renderer = new Renderer(tpl, assets));
  applyLeftMode();
  const localOrig = localStorage.getItem('rtm.cmp.origFile');
  if (localOrig) await useLocalOrig(localOrig);
  else if (tpl.youtube && tpl.youtube.id !== ytId) {
    ytId = tpl.youtube.id;
    $('orig').innerHTML = '<div id="ytPlayer"></div>';
    const y = new YouTubeSync($('ytPlayer'), ytId, (code) => {
      if (code === 101 || code === 150 || code === 100) showOrigFallback(code === 100 ? '유튜브 영상을 찾을 수 없어.' : '이 영상은 다른 사이트에서 재생이 막혀 있어.');
    });
    yt = y;
    y.whenReady().then(() => { applySound(); seek(frame); });
  }
  $<HTMLInputElement>('scrub').max = String(total() - 1);
  seek(Math.min(frame, total() - 1));
}

// ---------------- 원본: 내 파일로 대신 ----------------
function showOrigFallback(why: string) {
  $('orig').innerHTML = `<div class="origMsg">${why}<br>내 컴퓨터에 있는 원본 영상 파일로 대신 비교할 수 있어.<br><button id="origPick">📁 원본 영상 파일 고르기</button></div>`;
  $('origPick').onclick = pickOrig;
  yt = null;
}
async function pickOrig() {
  const added = await pickFiles('video/*');
  if (added.length) await useLocalOrig(added[0]);
}
async function useLocalOrig(file: string) {
  try {
    const url = await backend.mediaUrl(file);
    $('orig').innerHTML = '<video id="origVideo" playsinline preload="auto"></video>';
    const v = $<HTMLVideoElement>('origVideo');
    v.src = url;
    await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = j; });
    yt = new VideoSync(v);
    ytId = '';
    localStorage.setItem('rtm.cmp.origFile', file);
    applySound();
    seek(frame);
    toast('원본: ' + file);
  } catch {
    localStorage.removeItem('rtm.cmp.origFile');
    showOrigFallback(`“${file}” 을 열 수 없어.`);
  }
}
$('origFileBtn').onclick = pickOrig;
$('origYtBtn').onclick = () => {
  localStorage.removeItem('rtm.cmp.origFile');
  ytId = '';
  loadSelected();
};
$<HTMLInputElement>('origOffset').value = localStorage.getItem('rtm.cmp.offset') ?? '0';
$<HTMLInputElement>('origOffset').onchange = (e) => {
  localStorage.setItem('rtm.cmp.offset', (e.target as HTMLInputElement).value);
  seek(frame);
};

async function sourceList() {
  const sel = $<HTMLSelectElement>('cmpSource');
  const tpls = listTemplates();
  const projs = listProjects();
  sel.innerHTML = '';
  tpls.forEach((t, i) => sel.add(new Option(stealth.on ? `Template ${i + 1}` : t.name, `template:${t.id}`)));
  projs.forEach((p) => sel.add(new Option(p === '_autosave' ? '(자동 저장본)' : p, `project:${p}`)));
  const last = JSON.parse(localStorage.getItem('rtm.last') ?? '{"kind":"template","name":"rainbow-tylenol"}');
  sel.value = `${last.kind}:${last.name}`;
  if (!sel.value) sel.selectedIndex = 0;
}
const loadSelected = () => {
  const [kind, ...rest] = $<HTMLSelectElement>('cmpSource').value.split(':');
  return load(kind, rest.join(':'));
};
$('cmpSource').onchange = loadSelected;
$('reloadBtn').onclick = async () => { await loadSelected(); toast('다시 읽음'); };

function applyLeftMode() {
  const m = $<HTMLSelectElement>('leftMode').value;
  renderer.videoTest = m === 'video';
  renderer.testMode = m === 'sound';
  renderer.stealth = stealth.on;
  localStorage.setItem('rtm.cmp.left', m);
}
$('leftMode').onchange = applyLeftMode;

// ---------------- 재생 ----------------
// 시계: 우리 소리를 틀면 오디오 시계, 아니면 벽시계. 유튜브는 그 시계를 따라감
async function play() {
  if (playing || !tpl) return;
  actx.resume();
  if (frame >= total() - 1) seek(0);
  const ours = snd.oursOn && speed() === 1;
  if (snd.oursOn && speed() !== 1) toast('느린 재생에선 우리 소리는 꺼져');
  const start = songAt(frame);
  playing = true;
  $('playBtn').textContent = '⏸ 정지';
  await yt?.setRate(speed());
  yt?.play(start + lag());
  if (ours) {
    const at = actx.currentTime + 0.05;
    nodes = scheduleAll(actx, buses, tpl, assets, song, secToBeat(tpl, start), at, mix);
    audioClock = { ctx: at, song: start };
  } else wallClock = { at: performance.now() + 50, song: start };
}
function halt() {
  playing = false;
  yt?.pause();
  for (const n of nodes) try { n.stop(); } catch { /* 끝남 */ }
  nodes = [];
  audioClock = null;
  wallClock = null;
}
function stop() {
  if (!playing) return;
  const at = currentSong(); // 멈춘 위치 (playing 끄기 전에 읽어야 함)
  halt();
  frame = Math.max(0, Math.min(total() - 1, Math.round((at - t0()) * fps())));
  seek(frame);
  $('playBtn').textContent = '▶ 재생';
}
function currentSong() {
  if (playing && audioClock) return audioClock.song + Math.max(0, actx.currentTime - audioClock.ctx);
  if (playing && wallClock) return wallClock.song + (Math.max(0, performance.now() - wallClock.at) / 1000) * speed();
  return songAt(frame);
}
function seek(f: number) {
  const was = playing;
  if (was) halt();
  frame = Math.max(0, Math.min(total() - 1, Math.round(f)));
  if (was) play();
  else yt?.show(songAt(frame) + lag() + 0.001);
}
$('playBtn').onclick = () => (playing ? stop() : play());
$('b1').onclick = () => seek(frame - 1);
$('f1').onclick = () => seek(frame + 1);
$('b10').onclick = () => seek(frame - 10);
$('f10').onclick = () => seek(frame + 10);
$<HTMLInputElement>('scrub').oninput = (e) => seek(+(e.target as HTMLInputElement).value);
$('speed').onchange = () => { if (playing) { stop(); play(); } };

// ---------------- 구간 표시 / 복사 ----------------
function describe(f: number) {
  const s = songAt(f);
  const b = secToBeat(tpl, s);
  return { beat: b.toFixed(2), orig: (s + lag()).toFixed(2) };
}
function updateCopy() {
  if (markIn == null && markOut == null) return;
  const a = markIn ?? markOut!;
  const b = markOut ?? markIn!;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const A = describe(lo);
  const B = describe(hi);
  $<HTMLInputElement>('copyText').value = `F${lo}–F${hi} (박 ${A.beat}–${B.beat}, 원본 ${A.orig}s–${B.orig}s)`;
}
$('inBtn').onclick = () => { markIn = frame; updateCopy(); };
$('outBtn').onclick = () => { markOut = frame; updateCopy(); };
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  toast('복사됨!');
}
$('copyBtn').onclick = () => copy($<HTMLInputElement>('copyText').value);
$('frameBig').onclick = () => {
  const d = describe(frame);
  copy(`F${frame} (박 ${d.beat}, 원본 ${d.orig}s)`);
};

// ---------------- 원본 투명도 ----------------
const op = $<HTMLInputElement>('origOpacity');
op.value = localStorage.getItem('rtm.cmp.opacity') ?? '1';
const applyOpacity = () => {
  $('orig').style.opacity = op.value;
  localStorage.setItem('rtm.cmp.opacity', op.value);
};
op.oninput = applyOpacity;
applyOpacity();

// ---------------- 키보드 ----------------
window.addEventListener('keydown', (e) => {
  const tg = e.target;
  if (tg instanceof HTMLElement && tg.closest('input[type=text], select')) return;
  const k = e.key.toLowerCase();
  if (e.code === 'Space') { e.preventDefault(); playing ? stop() : play(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(frame - (e.shiftKey ? 10 : 1)); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); seek(frame + (e.shiftKey ? 10 : 1)); }
  else if (k === 'i') $('inBtn').click();
  else if (k === 'o') $('outBtn').click();
  else if (k === 'l') { const c = $<HTMLInputElement>('loopChk'); c.checked = !c.checked; }
  else if (k === 'c' && !e.metaKey && !e.ctrlKey) $('copyBtn').click();
});

// ---------------- 그리기 루프 ----------------
function tick() {
  if (tpl && renderer) {
    let f = frame;
    if (playing) {
      const s = currentSong();
      f = (s - t0()) * fps();
      // 유튜브가 밀리지 않게 보정
      yt?.follow(s + lag());
      const lo = markIn != null && markOut != null ? Math.min(markIn, markOut) : null;
      const hi = markIn != null && markOut != null ? Math.max(markIn, markOut) : null;
      if ($<HTMLInputElement>('loopChk').checked && lo != null && hi != null && f >= hi + 1) {
        seek(lo);
        f = lo;
      } else if (f >= total() - 1) {
        stop();
        f = frame;
      }
    }
    const shown = Math.max(0, Math.floor(f + 1e-6));
    const s = playing ? currentSong() : songAt(frame);
    const beat = secToBeat(tpl, s);
    renderer.render(g, beat);
    $<HTMLInputElement>('scrub').value = String(shown);
    $('frameBig').textContent = `F ${shown}`;
    const bar = Math.floor((beat - tpl.barOffset) / tpl.beatsPerBar) + 1;
    const bi = Math.floor((((beat - tpl.barOffset) % tpl.beatsPerBar) + tpl.beatsPerBar) % tpl.beatsPerBar) + 1;
    const si = tpl.scenes.findIndex((sc) => beat >= sc.start && beat < sc.end);
    const sc = tpl.scenes[si];
    const sounding = tpl.notes
      .filter((n) => n.beat <= beat + 1e-6 && beat < n.beat + n.len)
      .map((n) => letter(tpl.slots.findIndex((x) => x.id === n.slot)))
      .filter((x, i, a) => a.indexOf(x) === i)
      .join(',');
    $('frameSub').textContent =
      `+${(s - t0()).toFixed(2)}s · ${bar}.${bi}마디 (박 ${beat.toFixed(2)}) · 유튜브 ${(s + lag()).toFixed(2)}s` +
      (sc ? ` · 장면 ${si + 1} ${sc.layout}/${sc.text}` : '') +
      ((shot) => (shot ? ` · 컷 ${renderer.shotLabel(shot)}` : ''))(renderer.shotAt(beat)) +
      (sounding ? ` · 울리는 파트 ${sounding}` : '') +
      (markIn != null ? ` · [${markIn}` : '') + (markOut != null ? ` ${markOut}]` : '');
  }
  requestAnimationFrame(tick);
}

// 에이전트/콘솔 확인용: cmp.seek(프레임), cmp.frame
(window as unknown as Record<string, unknown>).cmp = { seek: (f: number) => seek(f), get frame() { return frame; }, reload: () => loadSelected() };

// ---------------- 시작 ----------------
(async () => {
  await chooseBackend();
  if (stealth.on) {
    $('cmpLogo').textContent = '⇆ Compare';
    document.title = 'Compare';
  }
  $<HTMLSelectElement>('leftMode').value = localStorage.getItem('rtm.cmp.left') ?? 'video';
  await document.fonts.load('900 40px "Apple SD Gothic Neo"').catch(() => {});
  await sourceList();
  await loadSelected();
  requestAnimationFrame(tick);
})();
