import { auditionNote, createBuses, makeBeep, scheduleAll, type Mix, type Override } from './audio';
import { backend, chooseBackend, modePref, setModePref, type ModePref } from './backend';
import { fetchAudio, loadAllAssets, loadSlotAssets, spriteUse, type Sprite, type SlotAssets } from './media';
import { downloadJson, getTemplate, listProjects, listTemplates, loadProject, pickJson, saveProject } from './store';
import { YouTubeSync } from './youtube';
import { PianoRoll } from './pianoroll';
import { renderScenePanel } from './scenes';
import { highlightSubPanel, renderSubPanel } from './subtitles';
import { newSlot, openSlotEditor, pickFiles, renderSlotList, type SlotHost } from './slots';
import { beatToSec, secToBeat, spb, uid, type Note, type Slot, type SubtitleGroup, type Template } from './types';
import { Renderer } from './visual';
import { setStealth, stealth } from './stealth';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------- 상태 ----------------
let tpl: Template;
const DEFAULT_TEMPLATE = 'rainbow-tylenol';
let source = { kind: 'template', name: DEFAULT_TEMPLATE } as { kind: 'template' | 'project'; name: string };
let assets = new Map<string, SlotAssets>();
let song: AudioBuffer | null = null;
const actx = new AudioContext({ sampleRate: 44100 });
// 볼륨 상태 (원곡 볼륨은 템플릿에, 나머지는 브라우저에 기억)
const vol = { songOn: true, synthOn: true, synth: 1, ...JSON.parse(localStorage.getItem('rtm.vol') ?? '{}') };
const buses = createBuses(actx, 0.8, vol.synth);
const mix: Mix = { muted: new Set(), solo: null, override: null };
// 소리 테스트: 모든 노트를 깨끗한 삑 하나로 (음정·타이밍 확인용)
let beep: Override | null = null;
// 원곡을 유튜브 원본 소리로 깔 때 (미리보기 전용 — mp4 에는 못 넣음)
const YT_SONG = '@youtube';
let yt: YouTubeSync | null = null;
const ytMode = () => tpl?.song.file === YT_SONG && !!tpl.youtube;
let renderer: Renderer;
let playing = false;
let playStartCtx = 0;
let playStartBeat = 0;
let playhead = 0;
let nodes: AudioScheduledSourceNode[] = [];
let dirty = false;
const undo: string[] = [];
const redo: string[] = [];
let clipboard: Note[] = [];
let selectedScene: number | null = null;

const canvas = $<HTMLCanvasElement>('preview');
const g2 = canvas.getContext('2d')!;
const status = (t: string) => ($('status').textContent = t);

// ---------------- 편집 공통 ----------------
function beginEdit() {
  undo.push(JSON.stringify(tpl));
  if (undo.length > 200) undo.shift();
  redo.length = 0;
}
function changed() {
  dirty = true;
  status('● 저장 안 됨');
  refreshSlots();
  roll.draw();
  if (playing) restartPlayback();
  scheduleAutosave();
}
let autosaveTimer = 0;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    saveProject('_autosave', tpl);
  }, 1500);
}
async function applySnapshot(json: string) {
  const oldSlots = JSON.stringify(tpl.slots);
  tpl = JSON.parse(json);
  if (JSON.stringify(tpl.slots) !== oldSlots) await reloadAssets();
  renderer.setData(tpl, assets);
  $<HTMLInputElement>('tuning').value = String(tpl.tuning ?? 0);
  roll.selected.clear();
  changed();
  renderScenePanel(sceneHost, $('scenePanel'), selectedScene);
  renderSubPanel(subHost, $('subPanel'));
}

// ---------------- 접었다 폈다 하는 칸 (상태 기억) ----------------
for (const d of document.querySelectorAll<HTMLDetailsElement>('details.fold')) {
  const k = `rtm.fold.${d.id}`;
  const v = localStorage.getItem(k);
  if (v != null) d.open = v === '1';
  d.addEventListener('toggle', () => localStorage.setItem(k, d.open ? '1' : '0'));
}
// 접기 제목줄 안 버튼은 눌러도 접히지 않게
$('addSlotBtn').addEventListener('click', (e) => e.preventDefault());

// ---------------- 피아노롤 ----------------
const roll = new PianoRoll(
  {
    tpl: () => tpl,
    currentSlot: () => slotHost.current,
    beginEdit,
    changed,
    seek: (b) => seek(b),
    audition: (n) => auditionNote(actx, buses.synth, tpl, assets, n, mix.override),
    selectScene: (i) => selectScene(i),
    selectionChanged: () => {},
  },
  $('rollPane'),
);

function selectScene(i: number | null) {
  selectedScene = i;
  roll.selectedScene = i;
  roll.draw();
  renderScenePanel(sceneHost, $('scenePanel'), i);
}
const sceneHost = { tpl: () => tpl, playhead: () => playhead, beginEdit, changed, selectScene };
const subHost = { tpl: () => tpl, beginEdit, changed, seek: (b: number) => seek(b), slotsIn: (gr: SubtitleGroup) => renderer.subGroupSlots(gr) };

// ---------------- 슬롯 ----------------
const slotHost: SlotHost = {
  tpl: () => tpl,
  assets: () => assets,
  actx: () => actx,
  master: () => buses.preview,
  current: '',
  muted: mix.muted,
  get solo() { return mix.solo; },
  set solo(v) { mix.solo = v; if (playing) restartPlayback(); },
  selectedCount: () => roll.selected.size,
  assignSelected: (id) => {
    if (!roll.selected.size) return status('먼저 피아노롤에서 노트를 선택해줘');
    beginEdit();
    for (const n of tpl.notes) if (roll.selected.has(n.id)) n.slot = id;
    changed();
  },
  beginEdit,
  slotChanged: async (s: Slot) => {
    assets.set(s.id, await loadSlotAssets(actx, tpl, s).catch((e) => { alert('클립 불러오기 실패: ' + e.message); return { buffer: null, sprite: null }; }));
    renderer.setData(tpl, assets);
  },
  slotDeleted: (id) => {
    beginEdit();
    tpl.slots = tpl.slots.filter((s) => s.id !== id);
    tpl.notes = tpl.notes.filter((n) => n.slot !== id);
    for (const sc of tpl.scenes) sc.pip = sc.pip?.filter((p) => p !== id);
    if (slotHost.current === id) slotHost.current = tpl.slots[0]?.id ?? '';
    changed();
  },
  changed,
};
const openEditor = (s: Slot, isNew = false) => openSlotEditor(slotHost, $<HTMLDialogElement>('slotDialog'), s, isNew);
function refreshSlots() {
  renderSlotList(slotHost, $('slotList'), (s) => openEditor(s));
}
$('addSlotBtn').onclick = async () => {
  const files = await backend.listFiles().catch(() => [] as string[]);
  openEditor(newSlot(tpl, files[0]), true);
};

// ---------------- 로딩 ----------------
async function reloadAssets() {
  status('클립 불러오는 중…');
  const errs: string[] = [];
  assets = await loadAllAssets(actx, tpl, (s, e) => errs.push(`${s.name}: ${(e as Error).message?.slice(0, 120)}`));
  if (errs.length) console.warn(errs);
  status(errs.length ? `⚠ 클립 ${errs.length}개 실패 (콘솔 확인)` : '');
}

async function load(kind: 'template' | 'project', name: string) {
  stop();
  status('불러오는 중…');
  tpl = kind === 'template' ? getTemplate(name) : loadProject(name);
  source = { kind, name };
  undo.length = redo.length = 0;
  canvas.width = tpl.video.width;
  canvas.height = tpl.video.height;
  canvas.style.aspectRatio = `${tpl.video.width} / ${tpl.video.height}`;
  slotHost.current = tpl.slots[0]?.id ?? '';
  ($('songGain') as HTMLInputElement).value = String(tpl.song.gain);
  $<HTMLInputElement>('tuning').value = String(tpl.tuning ?? 0);
  applyVolumes();
  const songP = loadSong();
  await reloadAssets();
  await songP;
  renderer ? renderer.setData(tpl, assets) : (renderer = new Renderer(tpl, assets));
  renderer.stealth = stealth.on;
  playhead = tpl.range.start;
  dirty = false;
  selectScene(null);
  renderSubPanel(subHost, $('subPanel'));
  refreshSlots();
  roll.resize();
  roll.centerOnNotes();
  status(stealth.on ? '열림' : `${kind === 'template' ? '템플릿' : '프로젝트'} “${name}” 열림`);
  localStorage.setItem('rtm.last', JSON.stringify(source));
}

// ---------------- 원곡 ----------------
/** 원곡: 고른 파일(브라우저/도우미) 또는 유튜브 원본 소리 또는 없음 */
async function loadSong() {
  song = null;
  const f = tpl.song.file;
  if (f && f !== YT_SONG) {
    song = await fetchAudio(actx, f, undefined, undefined, 2).catch((e) => {
      status('⚠ 원곡 불러오기 실패: ' + (e as Error).message);
      return null;
    });
  }
  const box = $('ytBox');
  box.hidden = !ytMode();
  if (ytMode() && !yt)
    yt = new YouTubeSync($('ytPlayer'), tpl.youtube!.id, (code) => {
      // 101/150: 영상 주인이 다른 사이트 재생을 막아 둠 → 유튜브 소리 못 씀
      status(code === 101 || code === 150 ? '⚠ 이 유튜브 영상은 다른 사이트 재생이 막혀 있어서 원곡으로 못 써. 원곡 파일을 골라 줘' : `⚠ 유튜브 오류 (${code})`);
      $('ytBox').hidden = true;
    });
  applyVolumes();
  refreshSongList();
}
async function refreshSongList() {
  const sel = $<HTMLSelectElement>('songSel');
  const files = await backend.listFiles().catch(() => [] as string[]);
  sel.innerHTML = '';
  sel.add(new Option('원곡 없음', ''));
  if (tpl.youtube) sel.add(new Option('유튜브 원본 소리 (미리보기용)', YT_SONG));
  for (const f of files) sel.add(new Option(f, f));
  if (tpl.song.file && ![...sel.options].some((o) => o.value === tpl.song.file)) sel.add(new Option(`${tpl.song.file} (없음)`, tpl.song.file));
  sel.add(new Option('📁 파일 추가…', '+'));
  sel.value = tpl.song.file;
}
$<HTMLSelectElement>('songSel').onchange = async (e) => {
  const sel = e.target as HTMLSelectElement;
  let v = sel.value;
  if (v === '+') {
    const added = await pickFiles('audio/*,video/*');
    if (!added.length) return refreshSongList();
    v = added[0];
  }
  beginEdit();
  tpl.song.file = v;
  changed();
  stop();
  await loadSong();
};

async function refreshProjectList() {
  const sel = $<HTMLSelectElement>('projectSelect');
  const tpls = listTemplates();
  const projs = listProjects();
  sel.innerHTML = '';
  const og1 = document.createElement('optgroup');
  og1.label = '템플릿';
  tpls.forEach((t, i) => og1.append(new Option(stealth.on ? `Template ${i + 1}` : t.name, `template:${t.id}`)));
  const og2 = document.createElement('optgroup');
  og2.label = '내 프로젝트';
  for (const p of projs) og2.append(new Option(p === '_autosave' ? '(자동 저장본)' : p, `project:${p}`));
  sel.append(og1, og2);
  sel.value = `${source.kind}:${source.name}`;
}
$<HTMLSelectElement>('projectSelect').onchange = async (e) => {
  const v = (e.target as HTMLSelectElement).value;
  if (dirty && !confirm('저장 안 한 변경이 있어. 그래도 열까? (자동 저장본에는 남아 있어)')) {
    (e.target as HTMLSelectElement).value = `${source.kind}:${source.name}`;
    return;
  }
  const [kind, ...rest] = v.split(':');
  await load(kind as 'template' | 'project', rest.join(':'));
};

async function saveAs(name?: string | null) {
  name ??= prompt('프로젝트 이름', source.kind === 'project' && source.name !== '_autosave' ? source.name : '내 버전');
  if (!name) return;
  saveProject(name, tpl);
  source = { kind: 'project', name };
  dirty = false;
  status(`💾 “${name}” 저장됨 (이 브라우저)`);
  localStorage.setItem('rtm.last', JSON.stringify(source));
  refreshProjectList();
}
const save = () => saveAs(source.kind === 'project' && source.name !== '_autosave' ? source.name : null);
$('saveBtn').onclick = save;
$('saveAsBtn').onclick = () => saveAs();
$('jsonOutBtn').onclick = () => downloadJson(source.kind === 'project' ? source.name : tpl.name, tpl);
$('jsonInBtn').onclick = async () => {
  const r = await pickJson();
  if (!r) return;
  saveProject(r.name, r.tpl);
  await load('project', r.name);
  refreshProjectList();
};

// ---------------- 재생 ----------------
const ytTime = (b: number) => beatToSec(tpl, b) + tpl.youtube!.lag;

function play() {
  if (playing) return;
  actx.resume();
  if (playhead >= tpl.range.end - 0.01 || playhead < tpl.range.start - 8) playhead = tpl.range.start;
  playing = true;
  playStartBeat = playhead;
  playStartCtx = actx.currentTime + 0.06;
  nodes = scheduleAll(actx, buses, tpl, assets, song, playStartBeat, playStartCtx, mix);
  if (ytMode()) yt?.play(ytTime(playhead));
  $('playBtn').textContent = '⏸ 정지';
}
function stop() {
  if (!playing) return;
  playing = false;
  for (const n of nodes) try { n.stop(); } catch { /* 이미 끝남 */ }
  nodes = [];
  if (ytMode()) yt?.pause();
  $('playBtn').textContent = '▶ 재생';
}
function restartPlayback() {
  if (!playing) return;
  playhead = currentBeat();
  stop();
  play();
}
function currentBeat() {
  if (!playing) return playhead;
  return playStartBeat + Math.max(0, actx.currentTime - playStartCtx) / spb(tpl);
}
function seek(b: number) {
  const was = playing;
  stop();
  playhead = b;
  roll.setPlayhead(b);
  if (was) play();
}
$('playBtn').onclick = () => (playing ? stop() : play());
$('homeBtn').onclick = () => seek(tpl.range.start);
$<HTMLSelectElement>('snapSel').onchange = (e) => (roll.snap = +(e.target as HTMLSelectElement).value);
// ---------------- 볼륨 / 테스트 모드 ----------------
function applyVolumes() {
  const songOn = $<HTMLInputElement>('songOn');
  const synthOn = $<HTMLInputElement>('synthOn');
  songOn.checked = vol.songOn;
  synthOn.checked = vol.synthOn;
  $<HTMLInputElement>('synthGain').value = String(vol.synth);
  const t = actx.currentTime;
  buses.song.gain.setTargetAtTime(vol.songOn ? tpl.song.gain : 0, t, 0.015);
  buses.synth.gain.setTargetAtTime(vol.synthOn ? vol.synth : 0, t, 0.015);
  yt?.setVolume(tpl.song.gain / 1.5, !vol.songOn);
  $<HTMLInputElement>('songGain').disabled = !vol.songOn;
  $<HTMLInputElement>('synthGain').disabled = !vol.synthOn;
  localStorage.setItem('rtm.vol', JSON.stringify(vol));
}
$<HTMLInputElement>('songGain').oninput = (e) => { tpl.song.gain = +(e.target as HTMLInputElement).value; applyVolumes(); };
$<HTMLInputElement>('synthGain').oninput = (e) => { vol.synth = +(e.target as HTMLInputElement).value; applyVolumes(); };
$<HTMLInputElement>('songOn').onchange = (e) => { vol.songOn = (e.target as HTMLInputElement).checked; applyVolumes(); };
$<HTMLInputElement>('synthOn').onchange = (e) => { vol.synthOn = (e.target as HTMLInputElement).checked; applyVolumes(); };

async function setTestMode(on: boolean) {
  const chk = $<HTMLInputElement>('testChk');
  chk.checked = on;
  if (on && !beep) beep = makeBeep(actx);
  mix.override = on ? beep : null;
  renderer.testMode = on;
  localStorage.setItem('rtm.test', on ? '1' : '0');
  restartPlayback();
  status(on ? '소리 테스트: 모든 노트를 삑 소리로' : '');
}
$<HTMLInputElement>('tuning').onchange = (e) => {
  beginEdit();
  tpl.tuning = Math.max(-100, Math.min(100, +(e.target as HTMLInputElement).value || 0));
  changed();
};
function applyStealth(on: boolean) {
  setStealth(on);
  if (renderer) renderer.stealth = on;
  $('logo').textContent = on ? 'Sequencer' : '🌈 Rainbow Tylenol Maker';
  document.title = on ? 'Sequencer' : 'Rainbow Tylenol Maker';
  $('stealthBtn').classList.toggle('on', on);
  $('testChk').nextElementSibling!.textContent = on ? ' Sound' : ' 🔊 소리 테스트';
  $('videoTestChk').nextElementSibling!.textContent = on ? ' Video' : ' 🎬 영상 테스트';
  if (tpl) {
    refreshSlots();
    roll.draw();
    refreshProjectList();
  }
}
$('stealthBtn').onclick = () => applyStealth(!stealth.on);
$<HTMLInputElement>('testChk').onchange = (e) => setTestMode((e.target as HTMLInputElement).checked);
function setVideoTest(on: boolean) {
  $<HTMLInputElement>('videoTestChk').checked = on;
  renderer.videoTest = on;
  localStorage.setItem('rtm.videoTest', on ? '1' : '0');
  status(on ? '영상 테스트: 클립 대신 알파벳 카드, 자막은 가나다' : '');
}
$<HTMLInputElement>('videoTestChk').onchange = (e) => setVideoTest((e.target as HTMLInputElement).checked);

function frame() {
  if (tpl && renderer) {
    if (playing) {
      playhead = currentBeat();
      if (playhead >= tpl.range.end) {
        if ($<HTMLInputElement>('loopChk').checked) {
          stop();
          playhead = tpl.range.start;
          play();
        } else {
          stop();
          playhead = tpl.range.end;
        }
      }
      roll.setPlayhead(playhead);
    }
    renderer.render(g2, playhead);
    if (playing && ytMode()) yt?.follow(ytTime(playhead));
    highlightSubPanel($('subPanel'), playhead);
    const sec = beatToSec(tpl, playhead);
    const rel = sec - beatToSec(tpl, tpl.range.start);
    const bar = Math.floor((playhead - tpl.barOffset) / tpl.beatsPerBar) + 1;
    const beatIn = Math.floor((((playhead - tpl.barOffset) % tpl.beatsPerBar) + tpl.beatsPerBar) % tpl.beatsPerBar) + 1;
    $('timeDisp').textContent = `${bar}.${beatIn} · +${rel.toFixed(2)}s`;
    $('timeDisp').title = `원곡 기준 ${sec.toFixed(2)}초`;
  }
  requestAnimationFrame(frame);
}

// ---------------- 키보드 ----------------
window.addEventListener('keydown', async (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('input, select, textarea, dialog')) return;
  const cmd = e.metaKey || e.ctrlKey;
  const sel = () => tpl.notes.filter((n) => roll.selected.has(n.id));
  if (e.code === 'Space') {
    e.preventDefault();
    playing ? stop() : play();
  } else if (e.key === 'Home') {
    seek(tpl.range.start);
  } else if (cmd && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    const [from, to] = e.shiftKey ? [redo, undo] : [undo, redo];
    const snap = from.pop();
    if (snap) {
      to.push(JSON.stringify(tpl));
      await applySnapshot(snap);
    }
  } else if (cmd && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  } else if (cmd && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    roll.selected = new Set(tpl.notes.map((n) => n.id));
    roll.draw();
  } else if (cmd && e.key.toLowerCase() === 'c') {
    clipboard = structuredClone(sel());
    status(`노트 ${clipboard.length}개 복사`);
  } else if (cmd && e.key.toLowerCase() === 'v') {
    if (!clipboard.length) return;
    beginEdit();
    const minB = Math.min(...clipboard.map((n) => n.beat));
    const at = Math.round(playhead / roll.snap) * roll.snap;
    const pasted = clipboard.map((n) => ({ ...n, id: uid(), beat: n.beat - minB + at }));
    tpl.notes.push(...pasted);
    roll.selected = new Set(pasted.map((n) => n.id));
    changed();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    roll.deleteNotes([...roll.selected]);
  } else if (e.key.startsWith('Arrow') && roll.selected.size) {
    e.preventDefault();
    beginEdit();
    for (const n of sel()) {
      if (e.key === 'ArrowUp') n.pitch += e.shiftKey ? 12 : 1;
      if (e.key === 'ArrowDown') n.pitch -= e.shiftKey ? 12 : 1;
      if (e.key === 'ArrowLeft') n.beat = Math.max(0, n.beat - roll.snap);
      if (e.key === 'ArrowRight') n.beat += roll.snap;
    }
    const first = sel()[0];
    if (first && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) auditionNote(actx, buses.synth, tpl, assets, first, mix.override);
    changed();
  } else if (/^[1-9]$/.test(e.key) && !cmd) {
    const s = tpl.slots[+e.key - 1];
    if (s) {
      slotHost.current = s.id;
      refreshSlots();
    }
  } else if (e.key.toLowerCase() === 'a' && !cmd) {
    slotHost.assignSelected(slotHost.current);
  } else if (e.key.toLowerCase() === 'h' && !cmd) {
    applyStealth(!stealth.on);
  } else if (e.key.toLowerCase() === 't' && !cmd) {
    setTestMode(!$<HTMLInputElement>('testChk').checked);
  } else if (e.key.toLowerCase() === 'v' && !cmd) {
    setVideoTest(!$<HTMLInputElement>('videoTestChk').checked);
  }
});
window.addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });

// ---------------- 내보내기 ----------------
// 설정 고르기 → (원본 화질이면) 1차로 어떤 소스 프레임이 필요한지 모아 원본 화질로 준비 → 프레임마다 그려서 인코더로
const EXPORT_PRESETS = [
  { id: 'wuxga1610', name: '1920×1200 (16:10, 화면 꽉 채움)', W: 1920, H: 1200, rW: 1920, rH: 1200 },
  { id: 'fhd169', name: '1920×1080 (16:9, 화면 꽉 채움)', W: 1920, H: 1080, rW: 1920, rH: 1080 },
  { id: 'fhd169bars', name: '1920×1080 (16:9, 3:2 화면 + 양옆 검은 띠)', W: 1920, H: 1080, rW: 1620, rH: 1080 },
  { id: 'fhd32', name: '1620×1080 (3:2 그대로)', W: 1620, H: 1080, rW: 1620, rH: 1080 },
  { id: 'small', name: '960×640 (3:2, 빠른 확인용)', W: 960, H: 640, rW: 960, rH: 640 },
];
$('exportBtn').onclick = async () => {
  stop();
  const dlg = $<HTMLDialogElement>('exportDialog');
  const saved = JSON.parse(localStorage.getItem('rtm.export') ?? '{}');
  dlg.innerHTML = `<h3>🎬 mp4 내보내기</h3>
    <div class="row"><label>해상도 <select id="exRes">${EXPORT_PRESETS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('')}</select></label></div>
    <div class="row"><label>프레임 <select id="exFps"><option value="60">60fps</option><option value="30">30fps</option></select></label></div>
    <div class="row"><label>소스 화질 <select id="exQ"><option value="hi">원본 화질 (다시 뽑음, 느림)</option><option value="lo">미리보기 화질 (빠름)</option></select></label></div>
    <div class="actions"><span></span><div><button id="exCancel">취소</button> <button id="exGo" class="primary">내보내기</button></div></div>`;
  $<HTMLSelectElement>('exRes').value = saved.res ?? 'wuxga1610';
  $<HTMLSelectElement>('exFps').value = saved.fps ?? '60';
  $<HTMLSelectElement>('exQ').value = saved.q ?? 'hi';
  dlg.showModal();
  $('exCancel').onclick = () => dlg.close();
  $('exGo').onclick = () => {
    const opt = { res: $<HTMLSelectElement>('exRes').value, fps: $<HTMLSelectElement>('exFps').value, q: $<HTMLSelectElement>('exQ').value };
    localStorage.setItem('rtm.export', JSON.stringify(opt));
    runExport(dlg, EXPORT_PRESETS.find((p) => p.id === opt.res)!, +opt.fps, opt.q === 'hi');
  };
};

async function runExport(dlg: HTMLDialogElement, preset: (typeof EXPORT_PRESETS)[number], fps: number, hiQ: boolean) {
  dlg.innerHTML = `<h3>🎬 mp4 내보내기 — ${preset.W}×${preset.H} ${fps}fps</h3><div id="exMsg">오디오 렌더링 중…</div><div class="progress"><div id="exBar"></div></div><div class="actions"><span></span><button id="exClose">닫기</button></div>`;
  let cancelled = false;
  $('exClose').onclick = () => { cancelled = true; dlg.close(); };
  const touched = new Set<Sprite>();
  try {
    const t0 = beatToSec(tpl, tpl.range.start);
    const dur = beatToSec(tpl, tpl.range.end) - t0;
    const off = new OfflineAudioContext(2, Math.ceil((dur + 0.1) * 44100), 44100);
    scheduleAll(off, createBuses(off, vol.songOn && !ytMode() ? tpl.song.gain : 0, vol.synthOn ? vol.synth : 0), tpl, assets, song, tpl.range.start, 0, mix);
    const mixed = await off.startRendering();
    const name = source.kind === 'project' ? source.name : 'rainbow-tylenol';
    // 그리는 크기로 맞춘 템플릿 (연출 위치·크기는 화면 비율로 정해져 있어서 그대로 따라옴)
    const expTpl: Template = { ...tpl, video: { ...tpl.video, width: preset.rW, height: preset.rH, fps } };
    const r = new Renderer(expTpl, assets);
    r.testMode = renderer.testMode;
    r.videoTest = renderer.videoTest;
    r.stealth = false; // 내보내기는 항상 진짜 글자로
    const total = Math.ceil(dur * fps);
    const beatAt = (i: number) => secToBeat(tpl, t0 + i / fps);
    const scratch = document.createElement('canvas');
    scratch.width = preset.rW;
    scratch.height = preset.rH;
    const sg = scratch.getContext('2d')!;
    /** 이 프레임에 필요한 (스프라이트, 프레임번호) — 그리지 않고 모으기만 */
    const needsOf = (i: number) => {
      const out: [Sprite, number][] = [];
      spriteUse.collect = (sp, k) => out.push([sp, k]);
      try { r.render(sg, beatAt(i)); } finally { spriteUse.collect = null; }
      return out;
    };
    const loaders = new Map<Sprite, Map<number, () => Promise<ImageBitmap>>>();
    if (hiQ && !r.videoTest) {
      const need = new Map<Sprite, Set<number>>();
      for (let i = 0; i < total; i++) {
        for (const [sp, k] of needsOf(i)) (need.get(sp) ?? need.set(sp, new Set()).get(sp)!).add(k);
        if (i % 60 === 0) $('exMsg').textContent = `필요한 소스 프레임 찾는 중… ${i + 1} / ${total}`;
        if (cancelled) return;
      }
      let n = 0;
      for (const [sp, set] of need) {
        $('exMsg').textContent = `원본 화질 프레임 준비 중… (${++n} / ${need.size}) ${sp.src.file.split('/').pop()}`;
        loaders.set(sp, await backend.hiFrames(sp, preset.rW, preset.rH, [...set]));
        if (cancelled) return;
      }
    }
    // 원본 화질 프레임은 그릴 때 필요한 것만 불러 두고, 최근 몇 장만 기억
    const lastUse = new Map<Sprite, Map<number, number>>();
    const ensureHi = async (i: number) => {
      for (const [sp, k] of needsOf(i)) {
        const ld = loaders.get(sp)?.get(k);
        if (!ld) continue;
        sp.hi ??= new Map();
        touched.add(sp);
        if (!sp.hi.has(k)) sp.hi.set(k, await ld());
        (lastUse.get(sp) ?? lastUse.set(sp, new Map()).get(sp)!).set(k, i);
      }
      if (i % 30 === 0)
        for (const sp of touched)
          for (const [k, bm] of sp.hi ?? [])
            if ((lastUse.get(sp)?.get(k) ?? -99) < i - 8) {
              bm.close();
              sp.hi!.delete(k);
            }
    };
    $('exMsg').textContent = '인코더 준비 중…';
    const session = await backend.beginExport(name, fps, preset.W, preset.H, mixed);
    const cv = document.createElement('canvas');
    cv.width = preset.rW;
    cv.height = preset.rH;
    const g = cv.getContext('2d')!;
    const outCv = document.createElement('canvas');
    outCv.width = preset.W;
    outCv.height = preset.H;
    const og = outCv.getContext('2d')!;
    const started = performance.now();
    for (let i = 0; i < total; i++) {
      if (cancelled) return session.cancel();
      if (loaders.size) await ensureHi(i);
      r.render(g, beatAt(i));
      // 그리는 크기와 출력 크기가 다르면 가운데 두고 양옆 검게
      let frameCv = cv;
      if (preset.rW !== preset.W || preset.rH !== preset.H) {
        og.fillStyle = '#000';
        og.fillRect(0, 0, preset.W, preset.H);
        og.drawImage(cv, (preset.W - preset.rW) / 2, (preset.H - preset.rH) / 2);
        frameCv = outCv;
      }
      await session.addFrame(frameCv, i);
      if (i % 5 === 0) {
        const left = (((performance.now() - started) / (i + 1)) * (total - i - 1)) / 1000;
        $('exMsg').textContent = `프레임 ${i + 1} / ${total} · 남은 시간 약 ${Math.ceil(left / 60)}분`;
        $('exBar').style.width = `${((i + 1) / total) * 100}%`;
      }
    }
    $('exMsg').textContent = '인코딩 마무리 중…';
    const out = await session.finish();
    $('exBar').style.width = '100%';
    $('exMsg').innerHTML = `완성! <a href="${out.url}" download="${out.filename}">⬇ ${out.filename} 받기</a>` +
      (ytMode() ? '<br><small>유튜브 원곡은 mp4 에 넣을 수 없어서 빠졌어. 원곡을 넣으려면 원곡 파일을 골라 줘.</small>' : '') +
      `<br><video src="${out.url}" controls autoplay style="margin-top:8px;max-width:100%"></video>`;
  } catch (e) {
    $('exMsg').textContent = '실패: ' + (e as Error).message;
  } finally {
    spriteUse.collect = null;
    for (const sp of touched) {
      for (const bm of sp.hi?.values() ?? []) bm.close();
      delete sp.hi;
    }
  }
}

// 콘솔 디버깅용
(window as unknown as Record<string, unknown>).rtm = {
  seek, play, stop, get tpl() { return tpl; }, get playhead() { return playhead; }, get backend() { return backend; },
  reloadAssets: async () => { await reloadAssets(); renderer.setData(tpl, assets); }, get assets() { return assets; },
};

// ---------------- 시작 ----------------
// ---------------- 처리 모드 (브라우저 / ffmpeg 도우미) ----------------
async function setupMode() {
  const { kind, helper } = await chooseBackend();
  const sel = $<HTMLSelectElement>('modeSel');
  sel.innerHTML = '';
  sel.add(new Option(`자동 (지금: ${kind === 'ffmpeg' ? 'ffmpeg' : '브라우저'})`, 'auto'));
  sel.add(new Option('브라우저', 'browser'));
  sel.add(new Option(helper ? 'ffmpeg 도우미' : 'ffmpeg 도우미 (꺼져 있음)', 'ffmpeg'));
  sel.value = modePref();
  sel.title = helper ? 'ffmpeg 도우미가 켜져 있어' : 'ffmpeg 도우미를 쓰려면: npm run helper -- --media 소스폴더';
  sel.onchange = () => {
    setModePref(sel.value as ModePref);
    location.reload();
  };
}

(async () => {
  await setupMode();
  applyStealth(stealth.on);
  await document.fonts.load('900 40px "Apple SD Gothic Neo"').catch(() => {});
  const last = localStorage.getItem('rtm.last');
  if (last) {
    try { source = JSON.parse(last); } catch { /* 무시 */ }
  }
  try {
    await load(source.kind, source.name);
  } catch {
    await load('template', DEFAULT_TEMPLATE);
  }
  await setTestMode(localStorage.getItem('rtm.test') === '1'); // 기본은 꺼짐
  setVideoTest(localStorage.getItem('rtm.videoTest') === '1');
  await refreshProjectList();
  requestAnimationFrame(frame);
})();
