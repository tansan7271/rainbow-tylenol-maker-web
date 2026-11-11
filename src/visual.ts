// 화면 렌더러: renderFrame(beat) 는 시간에 대한 순수 함수라 미리보기와 내보내기가 같은 그림을 그린다.
import { drawSpriteFrame, type SlotAssets } from './media';
import { letter } from './stealth';
import { midiName, pitchRate, slotAudioDur, spb, type Note, type Scene, type Shot, type Slot, type SubtitleGroup, type Template } from './types';

const FONT = '"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif';
/** 영상 테스트 자리표시 글자: 가나다…하 → 갸냐댜…햐 → 거너더… 순으로 이어짐 (자막 묶음마다 '가'부터 다시) */
const CHO = [0, 2, 3, 5, 6, 7, 9, 11, 12, 14, 15, 16, 17, 18]; // ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ
const JUNG = [0, 2, 4, 6, 8, 12, 13, 17, 18, 20]; // ㅏㅑㅓㅕㅗㅛㅜㅠㅡㅣ
const placeholder = (i: number) =>
  String.fromCharCode(0xac00 + (CHO[i % CHO.length] * 21 + JUNG[Math.floor(i / CHO.length) % JUNG.length]) * 28);
/** 추가 레이어: 높이(낮은 음/높은 음의 화면 중심 y 비율), 자체 자막 x(바깥→안쪽 비율), 미끄러짐·남는 시간(초) */
const LAYER_Y_LOW = 0.87;
const LAYER_Y_HIGH = 0.2;
const LAYER_TEXT_X0 = 0.115;
const LAYER_TEXT_X1 = 0.395;
const LAYER_TEXT_CREEP = 5 / 30; // 첫 프레임 뒤 남은 거리를 붙는 시간
const LAYER_TEXT_HOLD = 0.25;
/** 글자 띠(ticker): 높이(낮은 음/높은 음, 화면 비율), 음높이→높이 곡선 지수, 마지막 위로 흐름 속도, 강조 시간(초) */
const TICKER_Y_LOW = 0.8;
const TICKER_Y_HIGH = 0.2;
const TICKER_CURVE = 1.6;
const TICKER_DRIFT = 0.12; // 마지막에 위로 흐르는 속도(초당 화면 높이)
const TICKER_EMPH = 0.35;
/** 자막 이벤트 swoosh: 들어오는 시간(초), 다 보인 채 머무는 비율 */
const EVENT_IN = 0.12;
const EVENT_DRIFT = 0.24; // 들어온 뒤 흐르는 속도(초당 화면 폭)
const EVENT_SNAP = 0.1; // snap 으로 옮겨 가는 시간(초)
const BURST_DIST = 0.25;
const SPIN_PEAK_X = 0.33; // spinArc 왼쪽 고점 (화면 비율)
const SPIN_PEAK_Y = 0.1;
const SPIN_OUT = 0.35; // spinArc 시작·끝 점이 화면 밖으로 나가 있는 거리(화면 폭 비율)
const SPIN_MIN_SCALE = 0.05; // spinArc 양 끝 크기 비율 (거의 안 보임)
const SPIN_MAX_SCALE = 1.5; // spinArc 가운데(노트 타이밍) 크기 비율
const SPIN_SLOW = 0.8; // spinArc 가운데에서 느려지는 정도 (1 이면 멈춤)
const SPIN_YAW = 0.9; // spinArc y축 회전 폭(라디안): 시작은 오른쪽으로 MID+이만큼, 끝은 MID-이만큼
const SPIN_YAW_MID = 0.25; // 가운데('팍' 순간)에도 살짝 오른쪽을 바라봄
const SPIN_ROLL = 0.45; // spinArc 양 끝에서 z축으로 기울어지는 최대 각도(라디안)
const BOUNCE_TAU = 0.28; // bounceRight 출렁임이 잦아드는 시간(초)
const BOUNCE_PERIOD = 0.5; // 출렁임 한 번 주기(초)
const BOUNCE_DRIFT = 0.04; // 머무는 동안 왼쪽으로 천천히 흐르는 거리(화면 폭 비율) — 멈춘 순간이 없게
const BOUNCE_OUT = 0.15; // 끝에서 빠지는 구간 비율 // burst 가 가장자리로 미끄러지는 거리(화면 비율)
const EVENT_HOLD = 0.3;
const EVENT_TUMBLE = 0.5; // exit: 'tumble' 이 시작되는 지점(이벤트 길이 비율)
/** 3등분 띠 자막(layerTextStyle: 'bands'): 들어오는/나가는 구간 비율 */
const BAND_IN = 0.15;
const BAND_OUT = 0.2;
/** bands 레이어에서 박스가 자막보다 먼저 움직이는 시차(덩어리 길이 비율) */
const BAND_LAG = 0.08;
/** ease-out 으로 xs→x1 팍 들어와, x1→x2 천천히 흐르다, ease-in 으로 x2→xe 가속하며 나감 (e: 0~1) */
function bandX(e: number, xs: number, x1: number, x2: number, xe: number) {
  if (e < BAND_IN) return xs + (x1 - xs) * (1 - Math.pow(1 - e / BAND_IN, 3));
  if (e < 1 - BAND_OUT) return x1 + (x2 - x1) * ((e - BAND_IN) / (1 - BAND_IN - BAND_OUT));
  return x2 + (xe - x2) * Math.pow(Math.min(1, (e - (1 - BAND_OUT)) / BAND_OUT), 3);
}
/** 자막 묶음이 미끄러져 나가는 시간(박) */
const EXIT_BEATS = 0.2;

/** 묶음 문장을 노트 단위 조각으로: '/' 가 있으면 그걸로, 없으면 글자마다(뒤따르는 띄어쓰기는 앞 글자에 붙임) */
export function textUnits(text: string): string[] {
  if (text.includes('/')) return text.split('/');
  const u: string[] = [];
  for (const c of text) {
    if (/\s/.test(c)) {
      if (u.length) u[u.length - 1] += c;
    } else u.push(c);
  }
  return u;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function outlined(g: CanvasRenderingContext2D, text: string, x: number, y: number, px: number, fill = '#fff', alpha = 1) {
  g.save();
  g.globalAlpha = alpha;
  g.font = `900 ${px}px ${FONT}`;
  g.lineJoin = 'round';
  g.lineWidth = Math.max(2, px * 0.14);
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.strokeText(text, x, y);
  g.fillStyle = fill;
  g.fillText(text, x, y);
  g.restore();
}

/** 이미지를 가로축으로 뒤로 눕히고(tilt, 라디안. 윗변이 멀어짐) depth 만큼 멀리 보낸 것처럼 그림.
 *  원근 중심(소실점) vx, vy. 줄 단위로 크기를 달리 그려 사다리꼴 원근을 흉내 냄 */
function drawTilted(g: CanvasRenderingContext2D, img: HTMLCanvasElement, cx: number, cy: number, tilt: number, depth: number, vx: number, vy: number, alpha: number, scale = 1) {
  const F = 520; // 초점 거리(px). 작을수록 원근 왜곡이 셈
  const w = img.width;
  const h = img.height;
  const proj = (yr: number) => {
    const yl = yr * scale; // scale: 자리는 그대로 두고 글자 크기만
    const z = -yl * Math.sin(tilt) + depth; // 위쪽(yl<0)이 멀어짐
    const k = F / (F + Math.max(-F * 0.9, z));
    return { y: vy + (cy + yl * Math.cos(tilt) - vy) * k, k };
  };
  g.save();
  g.globalAlpha = Math.max(0, Math.min(1, alpha));
  const STEP = 2;
  for (let i = 0; i < h; i += STEP) {
    const a = proj(i - h / 2);
    const b = proj(Math.min(h, i + STEP) - h / 2);
    const sh = b.y - a.y; // 음수면 뒤집힌 면(한 바퀴 도는 중) — 줄마다 제자리에 그려서 자연히 뒤집혀 보임
    if (Math.abs(sh) <= 0.02) continue;
    const k = (a.k + b.k) / 2;
    const sw = w * k * scale;
    const sx = vx + (cx - vx) * k - sw / 2;
    g.drawImage(img, 0, i, w, Math.min(STEP, h - i), sx, Math.min(a.y, b.y), sw, Math.abs(sh) + 0.5);
  }
  g.restore();
}

/** '#rrggbb' 색을 k 배 밝기로 (k<1 이면 진하게) */
function shade(hex: string, k: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 'rgba(0,0,0,0.45)';
  const v = parseInt(m[1], 16);
  const c = (sh: number) => Math.round(((v >> sh) & 255) * k);
  return `rgb(${c(16)},${c(8)},${c(0)})`;
}

/** 이미지를 세로축으로 yaw(라디안)만큼 돌린 것처럼 (+ 면 오른쪽 끝이 멀어져 오른쪽을 바라봄). 줄(세로 2px) 단위 원근 */
function yawImage(img: HTMLCanvasElement, yaw: number) {
  const w = img.width;
  const h = img.height;
  const F = Math.max(w, h) * 1.6; // 글자 크기에 비례한 초점 거리 — 돌아간 게 눈에 보이게 원근을 셈
  const out = document.createElement('canvas');
  out.width = w;
  out.height = Math.ceil(h * 1.8);
  const g = out.getContext('2d')!;
  const proj = (xl: number) => {
    const k = F / (F + xl * Math.sin(yaw));
    return { x: w / 2 + xl * Math.cos(yaw) * k, k };
  };
  const STEP = 2;
  for (let i = 0; i < w; i += STEP) {
    const a = proj(i - w / 2);
    const b = proj(Math.min(w, i + STEP) - w / 2);
    const sw = b.x - a.x;
    if (Math.abs(sw) < 0.02) continue;
    const sh = h * ((a.k + b.k) / 2);
    g.drawImage(img, i, 0, Math.min(STEP, w - i), h, Math.min(a.x, b.x), (out.height - sh) / 2, Math.abs(sw) + 0.5, sh);
  }
  return out;
}

export class Renderer {
  private notes: Note[] = [];
  private slots = new Map<string, Slot>();
  private key = '';
  /** 영상 테스트용: 노트 id → 자리표시 글자 */
  private ph = new Map<string, string>();
  /** 테스트 모드: 화면을 멜로디 색으로 채우고 글자만 크게 */
  testMode = false;
  /** 위장 표시: 글자를 파트 이름(A, B…)으로 */
  stealth = false;
  /** 영상 테스트: 클립 대신 단색 카드(알파벳 + 좌/우 표시 + 진행 막대), 자막은 자리표시 글자(가나다…) */
  videoTest = false;

  constructor(private tpl: Template, private assets: Map<string, SlotAssets>) {}

  setData(tpl: Template, assets: Map<string, SlotAssets>) {
    this.tpl = tpl;
    this.assets = assets;
    this.key = '';
  }

  private prepare() {
    const k = this.tpl.notes.length + ':' + this.tpl.slots.length;
    this.slots = new Map(this.tpl.slots.map((s) => [s.id, s]));
    // 화면용 노트: 같은 순간에 여러 음(화음)이면 제일 높은 음 하나만 — 소리는 audio.ts 에서 전부 낸다
    const sorted = [...this.tpl.notes].sort((a, b) => a.beat - b.beat || b.pitch - a.pitch);
    this.notes = [];
    const last = new Map<string, Note>(); // 리드는 전체에서 하나, 반주는 슬롯별로 하나
    for (const n of sorted) {
      // 추가 레이어 파트는 화음도 음마다 따로 그림(묶지 않음)
      const key = this.isLayer(n) ? 'o:' + n.id : this.isBacking(n) ? 'b:' + n.slot : 'lead';
      const prev = last.get(key);
      if (prev && Math.abs(prev.beat - n.beat) < 1e-6) continue;
      this.notes.push(n);
      last.set(key, n);
    }
    // 영상 테스트 자리표시: 화면에 글자가 나오는 노트(반주·PIP 제외)에 자막 묶음 안 순서대로 가, 나, 다…
    this.ph.clear();
    const count = new Map<string, number>();
    for (const n of this.notes) {
      if (n.beat < this.tpl.range.start || this.isBacking(n) || !this.hasSub(n.slot)) continue;
      if (this.sceneAt(n.beat)?.pip?.includes(n.slot)) continue;
      const k = this.subGroupKey(n.beat);
      const i = count.get(k) ?? 0;
      count.set(k, i + 1);
      this.ph.set(n.id, placeholder(i));
    }
    this.key = k;
  }

  /** 자막 묶음에서 글자가 나오는 노트 수 (에디터 패널용) */
  subGroupSlots(gr: SubtitleGroup) {
    this.prepare();
    return this.notes.filter((n) => n.beat >= gr.start - 1e-6 && n.beat < gr.end - 1e-6 && this.ph.has(n.id)).length;
  }

  /** 이 박이 속한 자막 묶음 (지정 안 됐으면 undefined) */
  private subGroupOf(b: number) {
    return this.tpl.subtitleGroups?.find((gr) => gr.start <= b + 1e-6 && b < gr.end - 1e-6);
  }

  /** 자막 묶음 키: 지정된 묶음이 있으면 그것, 없으면 마디(+장면) */
  private subGroupKey(b: number) {
    const gr = this.subGroupOf(b);
    if (gr) return 'g' + this.tpl.subtitleGroups!.indexOf(gr);
    // 마디 단위 자동 묶음은 장면이 바뀌면 끊김 (화면 자막도 장면 안 노트만 쌓으니 자리표시 번호도 맞춤)
    return 'bar' + Math.floor((b - this.tpl.barOffset) / this.tpl.beatsPerBar) + '@' + (this.sceneAt(b)?.start ?? 0);
  }

  sceneAt(beat: number): Scene | null {
    let cur: Scene | null = null;
    for (const s of this.tpl.scenes) if (s.start <= beat + 1e-6 && (!cur || s.start >= cur.start)) cur = s;
    return cur ?? this.tpl.scenes[0] ?? null;
  }

  /** 노트가 시작된 뒤 경과 시간(초), gate면 노트 끝에서 멈춤 */
  private elapsed(n: Note, beat: number) {
    const slot = this.slots.get(n.slot);
    let eb = beat - n.beat;
    if (slot?.mode === 'gate') eb = Math.min(eb, n.len);
    return Math.max(0, eb) * spb(this.tpl);
  }

  /** 영상 테스트용 카드: 효과(거울/뒤집기/줌)가 눈에 보이게 좌·우 글자와 클립 진행 막대를 그림 */
  private slotCard(g: CanvasRenderingContext2D, slot: Slot, frac: number, x: number, y: number, w: number, h: number) {
    this.drawCard(g, letter(this.tpl.slots.indexOf(slot)), slot.color, frac, x, y, w, h);
  }

  /** flipped = 좌우 반전(좌/우 표시가 바뀜), flipV = 상하 반전(위 표시·진행 막대가 아래위로 바뀜). 글자 L 은 읽히게 안 뒤집음 */
  private drawCard(g: CanvasRenderingContext2D, L: string, color: string, frac: number, x: number, y: number, w: number, h: number, flipped = false, flipV = false) {
    g.save();
    g.fillStyle = color;
    g.fillRect(x, y, w, h);
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.lineWidth = Math.max(2, h * 0.01);
    g.strokeRect(x + 1, y + 1, w - 2, h - 2);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // 카드 글자는 자막과 헷갈리지 않게 외곽선 없이 카드색을 진하게 한 색으로
    const ink = shade(color, 0.55);
    const plain = (t: string, tx: number, ty: number, px: number) => {
      g.font = `900 ${px}px ${FONT}`;
      g.fillStyle = ink;
      g.fillText(t, tx, ty);
    };
    plain(L, x + w / 2, y + h * 0.46, h * 0.5);
    plain(flipped ? '우' : '좌', x + w * 0.1, y + h * 0.46, h * 0.13);
    plain(flipped ? '좌' : '우', x + w * 0.9, y + h * 0.46, h * 0.13);
    plain('위', x + w * 0.5, y + h * (flipV ? 0.9 : 0.1), h * 0.08);
    // 클립 재생 위치 (음이 높으면 빨리 차오름): 카드 아래쪽 가는 줄, 카드색 계열로 은은하게
    const bh = Math.max(2, h * 0.012);
    const by = flipV ? y + h * 0.12 - bh : y + h * 0.88;
    g.fillStyle = shade(color, 0.85);
    g.fillRect(x + w * 0.1, by, w * 0.8, bh);
    g.fillStyle = ink;
    const p = w * 0.8 * Math.max(0, Math.min(1, frac));
    g.fillRect(flipped ? x + w * 0.9 - p : x + w * 0.1, by, p, bh);
    g.restore();
  }

  private drawNote(g: CanvasRenderingContext2D, n: Note, beat: number, x: number, y: number, w: number, h: number) {
    const slot = this.slots.get(n.slot);
    if (this.videoTest && slot) {
      const rate = slot.videoFollowsPitch ? pitchRate(slot, n.pitch) : 1;
      return this.slotCard(g, slot, (this.elapsed(n, beat) * rate) / Math.min(4, slotAudioDur(slot)), x, y, w, h);
    }
    const sp = this.assets.get(n.slot)?.sprite;
    if (!slot || !sp) {
      g.fillStyle = slot?.color ?? '#222';
      g.globalAlpha = 0.35;
      g.fillRect(x, y, w, h);
      g.globalAlpha = 1;
      return;
    }
    const rate = slot.videoFollowsPitch ? pitchRate(slot, n.pitch) : 1;
    drawSpriteFrame(g, sp, this.elapsed(n, beat) * rate * sp.fps, x, y, w, h);
  }

  shotAt(beat: number): Shot | null {
    return this.tpl.shots?.find((s) => !s.over && s.start <= beat + 1e-6 && beat < s.end - 1e-6) ?? null;
  }

  /** 컷이 속한 흐름: 같은 슬롯 컷이 빈틈없이 이어지면 한 흐름(예: C1 C2' C3 C4' = C 한 덩어리가 좌우로 바뀜) */
  private shotRun(shot: Shot) {
    const shots = this.tpl.shots ?? [];
    const i = shots.indexOf(shot);
    const linked = (a: Shot, b: Shot) => a.slot === b.slot && Math.abs(a.end - b.start) < 1e-6;
    let a = i;
    while (a > 0 && linked(shots[a - 1], shots[a])) a--;
    let b = i;
    while (b < shots.length - 1 && linked(shots[b], shots[b + 1])) b++;
    return { start: shots[a].start, end: shots[b].end, part: i - a + 1, parts: b - a + 1 };
  }

  /** 화면 표시용 컷 이름: C, C', 흐름 안이면 C1, C2' … */
  shotLabel(shot: Shot) {
    const slot = this.slots.get(shot.slot);
    const L = letter(this.tpl.slots.findIndex((s) => s.id === shot.slot));
    const run = this.shotRun(shot);
    const numbered = run.parts > 1 && !slot?.shotRestart; // 컷마다 처음부터면 흐름 번호 없이 A, A'
    const num = shot.part ?? (numbered ? run.part : '');
    return (slot ? L : '?') + num + (shot.flip ? "'" : '') + (shot.flipV ? '↕' : '');
  }

  /** 컷 구간의 화면: 노트와 상관없이 컷의 슬롯 영상을 재생. 흐름 안에선 첫 컷부터 이어서(슬롯 shotRestart 면 컷마다 처음부터).
   *  영상이 없으면 false (노트 영상으로 대체) */
  private drawShot(g: CanvasRenderingContext2D, shot: Shot, beat: number, x: number, y: number, w: number, h: number) {
    const slot = this.slots.get(shot.slot);
    if (!slot) return false;
    const run = this.shotRun(shot);
    // clipAt 이 있으면 컷 시작 때 클립의 그 위치(박)부터. 아니면 흐름 시작(또는 컷마다 처음)부터
    const t0 = shot.clipAt != null ? shot.start - shot.clipAt : slot.shotRestart ? shot.start : run.start;
    const t1 = shot.clipAt != null ? t0 + slotAudioDur(slot) / spb(this.tpl) : slot.shotRestart ? shot.end : run.end;
    if (this.videoTest) {
      this.drawCard(g, this.shotLabel(shot), slot.color, (beat - t0) / (t1 - t0), x, y, w, h, shot.flip, shot.flipV);
      return true;
    }
    const sp = this.assets.get(slot.id)?.sprite;
    if (!sp) return false;
    g.save();
    if (shot.flip) {
      g.translate(2 * x + w, 0);
      g.scale(-1, 1);
    }
    if (shot.flipV) {
      g.translate(0, 2 * y + h);
      g.scale(1, -1);
    }
    drawSpriteFrame(g, sp, (beat - t0) * spb(this.tpl) * sp.fps, x, y, w, h);
    g.restore();
    return true;
  }

  render(g: CanvasRenderingContext2D, beat: number) {
    this.prepare();
    if (this.testMode && !this.videoTest) return this.renderTest(g, beat);
    const { width: W, height: H } = this.tpl.video;
    g.save();
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    const scene = this.sceneAt(beat);
    const pip = new Set(scene?.pip ?? []);
    const started = this.notes.filter((n) => n.beat <= beat + 1e-6 && n.beat >= this.tpl.range.start);
    const main = started.filter((n) => !pip.has(n.slot) && !this.isBacking(n));
    const inScene = (n: Note) => !!scene && n.beat >= scene.start - 1e-6 && n.beat < scene.end;
    const sceneMain = main.filter(inScene);
    const cur = main[main.length - 1];
    const shot = this.shotAt(beat);
    // 메인 화면 한 장: 컷이 있으면 컷 클립, 없으면 지금 노트의 슬롯 영상
    const drawMain = (x: number, y: number, w: number, h: number) => {
      if (shot && this.drawShot(g, shot, beat, x, y, w, h)) return;
      if (cur) this.drawNote(g, cur, beat, x, y, w, h);
    };

    // ---- 영상 레이어 ----
    if (cur || shot) {
      const layout = scene?.layout ?? 'full';
      const fx = new Set(scene?.fx ?? []);
      const el = cur ? this.elapsed(cur, beat) : 99;
      g.save();
      if (fx.has('zoomPunch')) {
        const s = 1 + 0.14 * Math.exp(-el * 9);
        g.translate(W / 2, H / 2);
        g.scale(s, s);
        g.translate(-W / 2, -H / 2);
      }
      if (fx.has('shake') && cur) {
        const r = hash(cur.id);
        const a = 14 * Math.exp(-el * 12);
        g.translate((r() - 0.5) * a * 2, (r() - 0.5) * a * 2);
      }
      if (fx.has('flipAlternate') && cur && sceneMain.indexOf(cur) % 2 === 1) {
        g.translate(0, H);
        g.scale(1, -1);
      }
      if (layout === 'mirror') {
        g.save();
        g.beginPath();
        g.rect(0, 0, W / 2, H);
        g.clip();
        drawMain(0, 0, W, H);
        g.restore();
        g.save();
        g.translate(W, 0);
        g.scale(-1, 1);
        g.beginPath();
        g.rect(0, 0, W / 2, H);
        g.clip();
        drawMain(0, 0, W, H);
        g.restore();
      } else if (layout === 'split') {
        const prev = main[main.length - 2];
        [prev, cur].forEach((n, i) => {
          if (!n) return;
          g.save();
          g.beginPath();
          g.rect((i * W) / 2, 0, W / 2, H);
          g.clip();
          this.drawNote(g, n, beat, (i * W) / 2 - W / 4, 0, W, H);
          g.restore();
        });
      } else if (layout === 'grid4') {
        main.slice(-4).forEach((n, i, arr) => {
          const k = (main.length - arr.length + i) % 4;
          this.drawNote(g, n, beat, (k % 2) * (W / 2), Math.floor(k / 2) * (H / 2), W / 2, H / 2);
        });
      } else {
        drawMain(0, 0, W, H);
      }
      g.restore();
    }

    // ---- 위에 덮는 컷(over): 팍 나타났다가 서서히 사라짐 ----
    for (const os of this.tpl.shots ?? []) {
      if (!os.over || beat < os.start - 1e-6 || beat >= os.end - 1e-6) continue;
      g.save();
      g.globalAlpha = 1 - (beat - os.start) / (os.end - os.start);
      this.drawShot(g, os, beat, 0, 0, W, H);
      g.restore();
    }

    // ---- 구석 작은 화면 (PIP) ----
    if (scene?.pip?.length) {
      const bw = W * 0.3;
      const bh = H * 0.3;
      scene.pip.forEach((sid, i) => {
        const slot = this.slots.get(sid);
        const sp = this.assets.get(sid)?.sprite;
        if (!slot || (!sp && !this.videoTest)) return;
        const dur = Math.min(4, slotAudioDur(slot));
        const last = started.filter((n) => n.slot === sid && inScene(n)).pop();
        const tSec = last
          ? this.elapsed(last, beat) * (slot.videoFollowsPitch ? pitchRate(slot, last.pitch) : 1)
          : ((((beat - scene.start) * spb(this.tpl)) % dur) + dur) % dur;
        for (const side of [0, 1]) {
          const y = H * (0.42 + (i % 2) * 0.03);
          g.save();
          if (side === 1) {
            g.translate(W, 0);
            g.scale(-1, 1);
          }
          if (this.videoTest) this.slotCard(g, slot, tSec / dur, W * 0.02, y, bw, bh);
          else drawSpriteFrame(g, sp!, tSec * sp!.fps, W * 0.02, y, bw, bh);
          g.restore();
        }
      });
    }

    // ---- 추가 레이어 (role: overlay) ----
    this.drawLayers(g, beat);

    // ---- 검은 화면으로 페이드 ----
    const fb = this.tpl.fadeToBlack;
    if (fb && beat >= fb.start - 1e-6) {
      g.save();
      g.globalAlpha = Math.min(1, (beat - fb.start) / Math.max(1e-6, fb.end - fb.start));
      g.fillStyle = '#000';
      g.fillRect(0, 0, W, H);
      g.restore();
    }

    // ---- 자막 레이어 ----
    if (scene && scene.text !== 'none') this.drawText(g, scene, beat, sceneMain, cur);
    this.drawTextEvents(g, beat);

    g.restore();
  }

  /** 노트 시작 = 빡! 켜짐, 노트 끝 = 바로 페이드 아웃. 짧게 연타하는 것도 눈에 들어오게 */
  private renderTest(g: CanvasRenderingContext2D, beat: number) {
    const { width: W, height: H } = this.tpl.video;
    g.save();
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const s = spb(this.tpl);
    const FADE = 0.12;
    const inRange = (n: Note) => n.beat <= beat + 1e-6 && n.beat >= this.tpl.range.start && n.beat < this.tpl.range.end;
    const all = this.notes.filter(inRange);
    // 같은 순간 울리는 음 이름들 (화음 표시용, 화면엔 제일 높은 음만)
    const chordOf = (n: Note, back: boolean) =>
      this.tpl.notes
        .filter((m) => Math.abs(m.beat - n.beat) < 1e-6 && this.isBacking(m) === back && (!back || m.slot === n.slot))
        .map((m) => m.pitch)
        .sort((a, b) => b - a)
        .filter((p, i, arr) => arr.indexOf(p) === i)
        .map(midiName)
        .join(' + ');
    const draw = (n: Note, y: number, h: number, big: boolean, back: boolean) => {
      const slot = this.slots.get(n.slot);
      const age = (beat - n.beat) * s;
      const len = n.len * s;
      const alpha = age <= len ? 1 : Math.max(0, 1 - (age - len) / FADE);
      if (alpha <= 0) return;
      const flash = Math.exp(-age / 0.05);
      g.globalAlpha = alpha;
      g.fillStyle = slot?.color ?? '#888';
      g.fillRect(0, y, W, h);
      g.fillStyle = `rgba(255,255,255,${0.5 * flash})`;
      g.fillRect(0, y, W, h);
      g.globalAlpha = 1;
      const lab = this.stealth ? this.label(n) : slot?.label || slot?.name || '?';
      if (big) {
        const px = Math.min(h * 0.45, (W * 0.85) / Math.max(1, [...lab].length));
        outlined(g, lab, W / 2, y + h * 0.45, px * (1 + 0.12 * flash), '#fff', alpha);
        outlined(g, chordOf(n, back), W / 2, y + h * 0.82, h * 0.08, '#fff', alpha * 0.9);
      } else {
        outlined(g, `${lab}  ${chordOf(n, back)}`, W / 2, y + h / 2, h * 0.5, '#fff', alpha);
      }
    };
    // 반주 파트: 아래쪽에 슬롯별 가로 띠
    const backSlots = this.tpl.slots.filter((x) => x.role === 'backing');
    const LANE = H * Math.min(0.1, 0.3 / Math.max(1, backSlots.length));
    const MH = H - LANE * backSlots.length;
    backSlots.forEach((bs, i) => {
      const n = all.filter((m) => m.slot === bs.id).pop();
      if (n) draw(n, MH + LANE * i, LANE, false, true);
    });
    const lead = all.filter((n) => !this.isBacking(n)).pop();
    if (lead) draw(lead, 0, MH, true, false);
    g.restore();
  }

  /** 메인 화면·메인 자막에서 빠지는 파트: 반주(backing) + 추가 레이어(overlay) */
  private isBacking(n: Note) {
    const r = this.slots.get(n.slot)?.role;
    return r === 'backing' || r === 'overlay';
  }

  private isLayer(n: Note) {
    return this.slots.get(n.slot)?.role === 'overlay';
  }

  /** 추가 레이어 화면. 대상: role 'overlay' 슬롯(기본 'pair') + layer 가 지정된 슬롯(메인 멜로디여도 위에 한 겹 더)
   *  pair: 노트마다 좌우 대칭(오른쪽은 거울) 작은 PIP 가 깜빡이고, 자체 자막이 바깥→안쪽으로 미끄러져 들어옴. 높이 = 음높이
   *  quad: 이어진 노트 덩어리마다 클립을 처음부터 정상 속도로 한 번, 화면 좌하단 4분면에.
   *        자체 자막(layerText)이 박스 위에서 나타나 오른쪽으로 미끄러지며 사라짐
   *  노트에 spot 이 있으면 pair 대신 그 4분면 하나에 클립이 깜빡이며 나옴
   *  영상 없는 슬롯은 자막만. 겹치면 여러 겹 */
  private drawLayers(g: CanvasRenderingContext2D, beat: number) {
    const { width: W, height: H } = this.tpl.video;
    const sp1 = spb(this.tpl);
    for (const slot of this.tpl.slots) {
      const style = slot.layer ?? (slot.role === 'overlay' ? 'pair' : null);
      if (!style) continue;
      const all = this.notes.filter((n) => n.slot === slot.id && n.beat >= this.tpl.range.start);
      if (!all.length) continue;
      const pMin = Math.min(...all.map((n) => n.pitch));
      const pMax = Math.max(...all.map((n) => n.pitch));
      const sprite = this.assets.get(slot.id)?.sprite;
      const hasVideo = this.videoTest ? !!slot.video : !!sprite;
      const L = letter(this.tpl.slots.indexOf(slot));
      const dur = Math.min(4, slotAudioDur(slot));
      const box = (n: Note, age: number, x: number, y: number, w: number, h: number, mirrored: boolean) => {
        const tSec = age * (slot.videoFollowsPitch ? pitchRate(slot, n.pitch) : 1);
        if (this.videoTest) this.drawCard(g, L, slot.color, tSec / dur, x, y, w, h, mirrored);
        else drawSpriteFrame(g, sprite!, tSec * sprite!.fps, x, y, w, h);
      };
      if (style === 'quad') {
        // 노트 사이가 0.5박 넘게 비면 새 덩어리
        let r0 = all[0];
        let rEnd = r0.beat + r0.len;
        const runs: [number, number][] = [];
        for (const n of all.slice(1)) {
          if (n.beat - rEnd > 0.5 + 1e-6) {
            runs.push([r0.beat, rEnd]);
            r0 = n;
          }
          rEnd = Math.max(rEnd, n.beat + n.len);
        }
        runs.push([r0.beat, rEnd]);
        // 덩어리 길이는 클립 길이까지만 (정상 재생 한 번)
        const clipBeats = slotAudioDur(slot) / sp1;
        const run = runs.map(([a, b]): [number, number] => [a, Math.min(b, a + clipBeats)]).find(([a, b]) => a <= beat + 1e-6 && beat < b);
        if (!run) continue;
        const e = (beat - run[0]) / (run[1] - run[0]);
        const age = (beat - run[0]) * sp1;
        const q = slot.layerQuad ?? 'bl';
        const qx = q[1] === 'r' ? W / 2 : 0;
        const qy = q[0] === 'b' ? H / 2 : 0;
        const bands = slot.layerTextStyle === 'bands';
        // bands: 박스도 자막처럼 오른쪽 밖 → 제자리 → 왼쪽 밖으로 흐름. 자막보다 BAND_LAG 만큼 먼저
        const eb = Math.min(1, e / (1 - BAND_LAG));
        const bx = bands ? bandX(eb, W, qx + W * 0.04, qx - W * 0.04, -W / 2) : qx;
        if (hasVideo && !(bands && eb >= 1)) {
          if (this.videoTest) this.drawCard(g, L, slot.color, e, bx, qy, W / 2, H / 2);
          else drawSpriteFrame(g, sprite!, age * sprite!.fps, bx, qy, W / 2, H / 2);
        }
        let text = slot.layerText || slot.label;
        if (this.stealth && !this.videoTest) text = L;
        if (this.videoTest) {
          let i = 0;
          text = text.replace(/\S/g, () => placeholder(i++));
        }
        if (text && bands && e >= BAND_LAG) {
          const et = (e - BAND_LAG) / (1 - BAND_LAG);
          // 화면 세로 3등분: 위 칸 = 크고 반투명, 오른쪽→왼쪽 / 가운데 칸 = 조금 작게, 왼쪽→오른쪽
          // 움직임: ease-out 으로 팍 들어와 천천히 흐르다가 ease-in 으로 가속하며 나감
          const band = (yc: number, px: number, alpha: number, dir: 1 | -1) => {
            g.save();
            g.font = `900 ${px}px ${FONT}`;
            const tw = g.measureText(text).width;
            const off = W / 2 + tw / 2 + px * 0.2; // 화면 밖까지 거리(중심 기준)
            const drift = W * 0.06;
            const x = bandX(et, -off, -drift, drift, off); // 중심이 화면 가운데서 떨어진 거리 (dir 방향이 +)
            outlined(g, text, W / 2 + dir * x, yc, px, '#fff', alpha);
            g.restore();
          };
          band(H / 6, H * 0.28, 0.45, -1);
          band(H / 2, H * 0.075, 1, 1);
        } else if (text && !bands) {
          // 박스 위(위쪽 4분면이면 아래)에서 나타나 오른쪽으로 미끄러지며 사라짐
          g.save();
          g.textAlign = 'left';
          const alpha = Math.min(1, e / 0.06) * (1 - e * e);
          const ty = qy > 0 ? qy - H * 0.05 : qy + H / 2 + H * 0.05;
          outlined(g, text, qx + W * (0.03 + 0.3 * e), ty, H * 0.06, '#fff', alpha);
          g.restore();
        }
        continue;
      }
      // 4분면 플래시: 노트에 spot 이 있으면 그 4분면에 깜빡. 화면 구간은 spotBeats(없으면 노트 길이), 가끔 1프레임씩 꺼짐
      for (const n of all) {
        if (!n.spot || !hasVideo) continue;
        const [s0, s1] = n.spotBeats ?? [n.beat, n.beat + n.len];
        if (beat < s0 - 1e-6 || beat >= s1 - 1e-6) continue;
        const age = (beat - s0) * sp1;
        const fi = Math.floor(age * 30);
        if (fi >= 2 && hash(n.id + ':' + fi)() < 0.25) continue;
        box(n, age, n.spot[1] === 'r' ? W / 2 : 0, n.spot[0] === 'b' ? H / 2 : 0, W / 2, H / 2, false);
      }
      all.forEach((n) => {
        const age = (beat - n.beat) * sp1; // 초
        const noteSec = n.len * sp1;
        if (age < 0 || age > noteSec + (style === 'pair' ? LAYER_TEXT_HOLD : 0)) return;
        const fi = Math.floor(age * 30); // 원본 프레임 단위 깜빡임
        if (n.spot) return; // 4분면 플래시는 아래에서 (화면 시간이 소리와 다를 수 있어서 따로)
        const lab = this.layerLabel(n);
        const k = pMax === pMin ? 0.5 : (n.pitch - pMin) / (pMax - pMin);
        const yc = H * (LAYER_Y_LOW - k * (LAYER_Y_LOW - LAYER_Y_HIGH));
        const bw = W * 0.3125;
        const bh = H * 0.32;
        // 박스: 노트 동안만, 처음 2프레임 뒤로는 가끔 1프레임씩 꺼짐
        if (hasVideo && age < noteSec && (fi < 2 || hash(n.id + ':' + fi)() > 0.25)) {
          for (const side of [0, 1]) {
            g.save();
            if (side === 1) {
              g.translate(W, 0);
              g.scale(-1, 1);
            }
            box(n, age, W * 0.025, yc - bh / 2, bw, bh, side === 1);
            g.restore();
          }
        }
        // 자체 자막: 박스와 같은 순간 바깥(박스 자리)에서 나와 안쪽으로. 아주 센 ease-out —
        // 첫 프레임에 75%를 확 오고, 남은 25%를 LAYER_TEXT_CREEP 동안 천천히 붙음. 노트가 끝나면 LAYER_TEXT_HOLD 동안 페이드아웃
        if (!lab) return;
        const f1 = 1 / 30;
        const slide = age < f1 ? 0.75 * Math.sqrt(age / f1) : 0.75 + 0.25 * (1 - Math.pow(1 - Math.min(1, (age - f1) / LAYER_TEXT_CREEP), 2));
        const x = W * (LAYER_TEXT_X0 + (LAYER_TEXT_X1 - LAYER_TEXT_X0) * slide);
        const alpha = age <= noteSec ? 1 : Math.max(0, 1 - (age - noteSec) / LAYER_TEXT_HOLD);
        for (const side of [0, 1]) {
          g.save();
          if (side === 1) {
            g.translate(W, 0);
            g.scale(-1, 1);
          }
          outlined(g, lab, x, yc, H * 0.05, '#fff', alpha);
          g.restore();
        }
      });
    }
  }

  /** 글자 띠: 첫 노트 글자 하나(영상 테스트면 "가")를 화면 가로 전체에 반복한 띠.
   *  높이는 멜로디 윤곽을 따라 출렁이며 올라감: 맨 아래에서 출발 → 음이 꺾이는 노트(꼭대기/골)마다 그 높이를 지나는데,
   *  사이는 부드러운 가감속(꺾이는 곳에서 속도 0). 마지막 음으로는 가속하며 올라가 이징 없이 탁 멈추고, 그 뒤 천천히 위로 흐르며 사라짐.
   *  첫 음과 마지막 음이 시작될 때 그 자리에서 반투명 복사본이 커지며 사라짐 */
  private drawTicker(g: CanvasRenderingContext2D, scene: Scene, beat: number) {
    const { width: W, height: H } = this.tpl.video;
    const sp1 = spb(this.tpl);
    const ns = this.notes.filter(
      (n) => n.beat >= scene.start - 1e-6 && n.beat < scene.end - 1e-6 && !this.isBacking(n) && !(scene.pip ?? []).includes(n.slot) && this.hasSub(n.slot),
    );
    if (!ns.length || beat < ns[0].beat - 1e-6 || beat >= scene.end - 1e-6) return;
    const slot = this.slots.get(ns[0].slot)!;
    const ch = this.videoTest ? '가' : this.stealth ? letter(this.tpl.slots.indexOf(slot)) : [...slot.label.trim()][0] ?? '가';
    const ps = ns.map((n) => n.pitch);
    const pMin = Math.min(...ps);
    const pMax = Math.max(...ps);
    // 낮은 음 쪽은 촘촘히, 높은 음에서 크게 올라가게 (지수 TICKER_CURVE)
    const yOf = (p: number) => H * (TICKER_Y_LOW - Math.pow(pMax === pMin ? 0.5 : (p - pMin) / (pMax - pMin), TICKER_CURVE) * (TICKER_Y_LOW - TICKER_Y_HIGH));
    const last = ns[ns.length - 1];
    let keys: [number, number][];
    if (scene.tickerKeys?.length) {
      // 장면에 직접 정한 출렁임: [몇 번째 노트, 높이 비율]
      keys = scene.tickerKeys.filter(([i]) => i >= 0 && i < ns.length).map(([i, y]): [number, number] => [ns[i].beat, H * y]);
    } else {
      // 기본: 멜로디가 꺾이는 노트마다 그 음 높이
      keys = [[ns[0].beat, H * TICKER_Y_LOW]];
      for (let i = 1; i < ns.length - 1; i++) if ((ps[i] - ps[i - 1]) * (ps[i + 1] - ps[i]) < 0) keys.push([ns[i].beat, yOf(ps[i])]);
      if (ns.length > 1) keys.push([last.beat, yOf(last.pitch)]);
    }
    if (!keys.length) keys = [[ns[0].beat, H * TICKER_Y_LOW]];
    const smooth = (u: number) => u * u * (3 - 2 * u);
    const yAt = (b: number) => {
      if (b <= keys[0][0]) return keys[0][1];
      const k = keys.length - 1;
      if (b >= keys[k][0]) return keys[k][1] - H * TICKER_DRIFT * (b - keys[k][0]) * sp1; // 탁 멈춘 뒤 천천히 위로
      let i = 0;
      while (keys[i + 1][0] < b) i++;
      const u = (b - keys[i][0]) / (keys[i + 1][0] - keys[i][0]);
      const e = i + 1 === k ? u * u * u : smooth(u); // 마지막 구간은 가속만 하고 도착하면 바로 멈춤
      return keys[i][1] + (keys[i + 1][1] - keys[i][1]) * e;
    };
    // 마지막 음 뒤로는 장면 끝까지 서서히 사라짐
    const alpha = beat <= last.beat ? 1 : Math.max(0, 1 - (beat - last.beat) / Math.max(1e-6, scene.end - last.beat));
    const color = scene.textColor ?? '#fff';
    const px = H * 0.11;
    g.save();
    g.font = `900 ${px}px ${FONT}`;
    const cw = g.measureText(ch).width + px * 0.08;
    g.restore();
    const band = (cy: number, scale: number, a: number) => {
      g.save();
      g.translate(W / 2, cy);
      g.scale(scale, scale);
      const n = Math.ceil(W / scale / cw / 2) + 1;
      for (let i = -n; i <= n; i++) outlined(g, ch, i * cw, 0, px, color, a);
      g.restore();
    };
    band(yAt(beat), 1, alpha);
    for (const b0 of ns.length > 1 ? [ns[0].beat, last.beat] : [ns[0].beat]) {
      const u = ((beat - b0) * sp1) / TICKER_EMPH;
      if (u >= 0 && u < 1) band(yAt(b0), 1 + 0.6 * u, 0.5 * (1 - u));
    }
  }

  /** 자막 이벤트(template.texts): 장면 자막과 별개로, 정해진 박에 정해진 자리로 나오는 글자.
   *  swoosh: from 쪽 화면 밖에서 슉 들어와(ease-out) 그 방향으로 천천히 계속 흐르며 사라짐 */
  private drawTextEvents(g: CanvasRenderingContext2D, beat: number) {
    const { width: W, height: H } = this.tpl.video;
    const sp1 = spb(this.tpl);
    for (const ev of this.tpl.texts ?? []) {
      if (beat < ev.start - 1e-6 || beat >= ev.end - 1e-6) continue;
      // 자막 칸(field) 을 쓰면 그 문장, unit 이 있으면 그 문장의 unit 번째 조각만
      const field = ev.field ? this.tpl.textFields?.find((f) => f.id === ev.field) : undefined;
      const full = field ? field.text : ev.text ?? '';
      let text = ev.unit != null ? textUnits(full)[ev.unit] ?? '' : full;
      if (!text.trim()) continue;
      if (ev.unit != null && !ev.literal && (this.videoTest || this.stealth)) text = placeholder(ev.unit); // 묶음 안 순서대로 가나다
      if (ev.anim === 'static') {
        // 고정 자막: 움직임·외곽선 없이 그 자리에 (literal 이면 영상 테스트·위장 표시에서도 그대로)
        if (!ev.literal && (this.videoTest || this.stealth)) {
          let i = 0;
          text = text.replace(/\S/g, () => placeholder(i++));
        }
        g.save();
        g.font = `${ev.weight ?? 400} ${H * (ev.size ?? 0.08)}px ${ev.font ?? FONT}`;
        g.fillStyle = ev.color ?? '#fff';
        g.globalAlpha = Math.min(1, ((beat - ev.start) * sp1) / 0.15);
        g.fillText(text, W * ev.x, H * ev.y);
        g.restore();
        continue;
      }
      if (!ev.literal && (this.videoTest || this.stealth)) {
        let i = 0;
        text = text.replace(/\S/g, () => placeholder(i++));
      }
      const e = (beat - ev.start) / (ev.end - ev.start);
      const age = (beat - ev.start) * sp1;
      const px = H * (ev.size ?? 0.13);
      const color = ev.color ?? '#fff';
      if (ev.anim === 'spinArc') {
        // 글자 중심을 지나는 가로축으로 두 바퀴 팽팽 돌면서 심장박동 같은 곡선을 따라감:
        // 오른쪽 가운데에서 나와 → 오른쪽 저점(높이 y = 자기 멜로디, 낮은 음일수록 깊게) → 왼쪽 고점(모두 같음) → 왼쪽 가운데로 나감.
        // 네 점을 Catmull-Rom 곡선으로 부드럽게 이음 (구간마다 같은 시간)
        const pts: [number, number][] = [
          [W * (1 + SPIN_OUT), H * 0.5],
          [W * (ev.x ?? 0.65), H * ev.y],
          [W * SPIN_PEAK_X, H * SPIN_PEAK_Y],
          [-W * SPIN_OUT, H * 0.5],
        ];
        // 속도: 가운데(노트 타이밍)에서 확 느려져 '팍' 찍히고(멈추진 않음), 양 끝은 빠르게
        const pp = Math.min(1, Math.max(0, e + (SPIN_SLOW / (2 * Math.PI)) * Math.sin(2 * Math.PI * e)));
        const seg = Math.min(2, Math.floor(pp * 3));
        const u = pp * 3 - seg;
        const P = (i: number) => pts[Math.max(0, Math.min(3, i))];
        const cr = (k: 0 | 1) => {
          const p0 = P(seg - 1)[k], p1 = P(seg)[k], p2 = P(seg + 1)[k], p3 = P(seg + 2)[k];
          return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
        };
        const px2 = cr(0);
        const py2 = cr(1);
        // 두 바퀴(4π). 화면 가운데를 소실점으로 원근을 줘서, 가운데보다 왼쪽에 있으면 왼쪽을 살짝 보는 것처럼 비틀림
        // 크기: 양 끝은 거의 안 보일 만큼 작고, 가운데에서 SPIN_MAX_SCALE 배로 확 커짐
        const sc = SPIN_MIN_SCALE + (SPIN_MAX_SCALE - SPIN_MIN_SCALE) * Math.pow(Math.sin(Math.PI * pp), 3);
        // 화면 안쪽 회전(z축): 가운데에선 똑바로, 양 끝으로 갈수록 글자마다 다른 방향으로 기울어짐
        const zr = (hash((ev.field ?? ev.text ?? "") + ev.start)() < 0.5 ? -1 : 1) * SPIN_ROLL * (pp - 0.5) * 2;
        g.save();
        g.translate(px2, py2);
        g.rotate(zr);
        g.translate(-px2, -py2);
        // 두 바퀴: 가운데(pp = 0.5)에서 정확히 한 바퀴째 = 정방향
        // y축: 오른쪽을 살짝 바라보며 나와서 왼쪽을 바라보며 사라짐
        const yaw = SPIN_YAW_MID + SPIN_YAW * (1 - 2 * pp);
        const img = yawImage(this.textImage(text, px, color), yaw);
        // 얇은 종이 카드처럼: 옆으로 누울수록(빛을 덜 받을수록) 어둡게, 뒷면은 조금 더 어둡게
        const ct = Math.cos(4 * Math.PI * pp);
        const lit = (0.3 + 0.7 * Math.abs(ct) * (ct < 0 ? 0.8 : 1)) * (0.75 + 0.25 * Math.cos(yaw));
        if (lit < 0.999) {
          const ig = img.getContext('2d')!;
          ig.globalCompositeOperation = 'source-atop';
          ig.fillStyle = `rgba(0,0,0,${1 - lit})`;
          ig.fillRect(0, 0, img.width, img.height);
        }
        drawTilted(g, img, px2, py2, 4 * Math.PI * pp, 0, W / 2, H / 2, 1, sc);
        g.restore();
        continue;
      }
      if (ev.anim === 'bounceRight') {
        // 오른쪽 정렬(오른쪽 끝 = x)로 붙는 말풍선식 자막: 오른쪽 밖에서 튕기듯 들어와(감쇠 진동) 머물다 오른쪽으로 빠짐.
        // 글자 오른쪽 끝 위·아래에 만화식 '말하는 표시'(> 모양 두 줄)가 같이 붙어 다님
        g.save();
        g.font = `900 ${px}px ${FONT}`;
        const tw = g.measureText(text).width;
        g.restore();
        const A = W * (1 - ev.x) + tw + px; // 화면 밖까지 거리
        const outU = (e - (1 - BOUNCE_OUT)) / BOUNCE_OUT;
        const sway = A * Math.exp(-age / BOUNCE_TAU) * Math.cos((2 * Math.PI * age) / BOUNCE_PERIOD) - W * BOUNCE_DRIFT * e;
        const off = outU > 0 ? sway + A * outU * outU * outU : sway;
        const xr = W * ev.x + off;
        const yc = H * ev.y;
        g.save();
        g.textAlign = 'right';
        outlined(g, text, xr, yc, px, color);
        g.restore();
        g.save();
        g.lineCap = 'round';
        for (const [lw, st] of [[Math.max(3, px * 0.16), 'rgba(0,0,0,0.85)'], [Math.max(1.5, px * 0.07), color]] as const) {
          g.lineWidth = lw;
          g.strokeStyle = st;
          g.beginPath();
          g.moveTo(xr - px * 0.55, yc - px * 1.55);
          g.lineTo(xr + px * 0.1, yc - px * 0.7);
          g.moveTo(xr + px * 0.1, yc + px * 0.7);
          g.lineTo(xr - px * 0.55, yc + px * 1.55);
          g.stroke();
        }
        g.restore();
        continue;
      }
      if (ev.anim === 'band') {
        // 띠: from 쪽 밖에서 ease-out 으로 슝 들어와 천천히 흐르다 ease-in 으로 반대쪽 밖으로 슝 나감
        const d = ev.from === 'right' ? -1 : 1;
        g.save();
        g.font = `900 ${px}px ${FONT}`;
        const off = W / 2 + g.measureText(text).width / 2 + px * 0.2;
        g.restore();
        const cx = W * ev.x;
        const drift = W * 0.06;
        const x = bandX(e, cx - d * (off + Math.abs(cx - W / 2)), cx - d * drift, cx + d * drift, cx + d * (off + Math.abs(cx - W / 2)));
        outlined(g, text, x, H * ev.y, px, color, ev.alpha ?? 1);
        continue;
      }
      if (ev.anim === 'burst' && !ev.to) {
        // 제자리 번쩍: 빠른 페이드 인 → 페이드 아웃
        const a = (ev.alpha ?? 0.45) * Math.min(1, e / 0.2) * Math.min(1, (1 - e) / 0.5);
        outlined(g, text, W * ev.x, H * ev.y, px, color, a);
        continue;
      }
      if (ev.anim === 'burst') {
        // 크게 팟 뜨고, to 쪽 가장자리로 미끄러지며 사라짐
        const k = 1 - Math.pow(1 - e, 3);
        const [dx, dy] = ev.to === 'left' ? [-1, 0] : ev.to === 'up' ? [0, -1] : ev.to === 'down' ? [0, 1] : [1, 0];
        g.save();
        g.globalAlpha = (ev.alpha ?? 0.6) * (1 - e);
        g.font = `900 ${px}px ${FONT}`;
        g.fillStyle = color;
        g.fillText(text, W * (ev.x + dx * BURST_DIST * k), H * (ev.y + dy * BURST_DIST * k));
        g.restore();
        continue;
      }
      // swoosh: from 쪽 밖에서 슉 들어와 그 방향으로 천천히 흐름
      const dir = ev.from === 'right' ? -1 : 1; // 움직이는 방향 (+ = 오른쪽)
      const drift = ev.drift ?? EVENT_DRIFT;
      // from 쪽 화면 밖에서 출발해 착지점(x)까지 ease-out, 그 뒤 같은 방향으로 천천히
      const startX = dir > 0 ? -px : W + px;
      const posAt = (a: number) => W * ev.x + (startX - W * ev.x) * Math.pow(1 - Math.min(1, a / EVENT_IN), 3) + dir * W * drift * a;
      let x = posAt(age);
      let y = H * ev.y;
      if (ev.snap && beat >= ev.snap.at - 1e-6) {
        // snap: 그 박에 새 자리로 슉 옮겨 가서 멈춤
        const a0 = (ev.snap.at - ev.start) * sp1;
        const v = 1 - Math.pow(1 - Math.min(1, (age - a0) / EVENT_SNAP), 3);
        x = posAt(a0) + (W * ev.snap.x - posAt(a0)) * v;
        y = H * (ev.y + (ev.snap.y - ev.y) * v);
      }
      const tStart = ev.exitAt != null ? (ev.exitAt - ev.start) / (ev.end - ev.start) : EVENT_TUMBLE;
      if (ev.exit === 'tumble' && e > tStart) {
        // 뒤로 누우면서(윗변이 멀어지게) 소실점 쪽으로 쓕 멀어지며 사라짐
        const u = (e - tStart) / (1 - tStart);
        const ease = u * u;
        drawTilted(g, this.textImage(text, px, color), x, y, (Math.PI / 2) * 0.95 * ease, 2600 * ease, W / 2, H * 0.45, 1 - Math.pow(u, 4));
        continue;
      }
      if (ev.exit === 'fly' && e > tStart) {
        // 빠지기 시작할 때 있던 자리에서 가장 가까운 화면 꼭짓점 쪽 대각선으로 가속하며 뻗어 나감
        const u = (e - tStart) / (1 - tStart);
        const x0 = posAt(tStart * (ev.end - ev.start) * sp1);
        const dx = x0 < W / 2 ? -1 : 1;
        const dy = y < H / 2 ? -1 : 1;
        const dist = Math.hypot(W, H) * 0.7 * u * u * u;
        outlined(g, text, x0 + (dx * dist) / Math.SQRT2, y + (dy * dist) / Math.SQRT2, px, color, 1);
        continue;
      }
      // 사라짐: snap 이 있으면 끝 0.25박 동안, 아니면 EVENT_HOLD 뒤로 서서히
      const alpha =
        ev.exit === 'tumble' || ev.exit === 'fly' ? 1
        : ev.snap ? Math.min(1, (ev.end - beat) / 0.25)
        : 1 - Math.max(0, (e - EVENT_HOLD) / (1 - EVENT_HOLD));
      outlined(g, text, x, y, px, color, alpha);
    }
  }

  private textCache = new Map<string, HTMLCanvasElement>();
  /** 외곽선 글자를 따로 그린 이미지 (3D 회전처럼 줄 단위로 늘이고 줄이는 효과용) */
  private textImage(text: string, px: number, color: string) {
    const key = `${text}|${Math.round(px)}|${color}`;
    let c = this.textCache.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    const g = c.getContext('2d')!;
    g.font = `900 ${px}px ${FONT}`;
    c.width = Math.ceil(g.measureText(text).width + px * 0.4);
    c.height = Math.ceil(px * 1.4);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    outlined(g, text, c.width / 2, c.height / 2, px, color);
    if (this.textCache.size > 64) this.textCache.clear();
    this.textCache.set(key, c);
    return c;
  }

  /** 레이어 자체 자막: 영상 테스트면 '가', 위장 표시면 파트 글자, 아니면 슬롯 글자 (메인 자막 자리표시와 별개) */
  private layerLabel(n: Note) {
    const slot = this.slots.get(n.slot);
    if (!slot || slot.noSub) return '';
    if (this.videoTest) return '가';
    if (this.stealth) return letter(this.tpl.slots.indexOf(slot));
    return slot.label || '가';
  }

  /** 이 슬롯 노트가 자막에 나오나 (noSub 면 안 나옴) */
  private hasSub(id: string) {
    const s = this.slots.get(id);
    return !!s && !s.noSub;
  }

  /** 노트의 자막 글자: 영상 테스트·글자 비움 → 자리표시(가나다…), 위장 표시 → 파트 글자, 아니면 슬롯 글자 */
  private label(n: Note) {
    const s = this.slots.get(n.slot);
    if (!s || s.noSub) return '';
    if (this.videoTest || !s.label.trim()) return this.ph.get(n.id) ?? '가';
    if (this.stealth) return letter(this.tpl.slots.indexOf(s));
    return s.label;
  }

  private drawText(g: CanvasRenderingContext2D, scene: Scene, beat: number, notes: Note[], cur: Note | undefined) {
    const { width: W, height: H } = this.tpl.video;
    const color = scene.textColor ?? '#fff';
    const labeled = notes.filter((n) => this.label(n));

    if (scene.text === 'subtitle') {
      const px = H * 0.055;
      const line = (phrase: string[], dx: number) => {
        g.font = `900 ${px}px ${FONT}`;
        while (phrase.length > 1 && g.measureText(phrase.join(' ')).width > W * 0.92) phrase.shift();
        if (phrase.length) outlined(g, phrase.join(' '), W / 2 + dx, H * 0.92, px, color);
      };
      // 묶음 문장: 영상 테스트(자리표시)·위장 표시에선 안 씀 → 슬롯 글자
      const groupText = (gr: SubtitleGroup) => (gr.textFrom != null ? this.tpl.subtitleGroups?.[gr.textFrom]?.text : gr.text) ?? '';
      const useText = (gr: SubtitleGroup) => !!groupText(gr).trim() && !this.videoTest && !this.stealth;
      const groupNotes = (gr: SubtitleGroup) =>
        this.notes.filter((n) => n.beat >= gr.start - 1e-6 && n.beat < gr.end - 1e-6 && this.ph.has(n.id));
      const groupLine = (gr: SubtitleGroup, upTo: number) => {
        const all = groupNotes(gr);
        const k = all.filter((n) => n.beat <= upTo + 1e-6).length;
        if (useText(gr)) {
          const u = textUnits(groupText(gr));
          return [(k >= all.length ? u : u.slice(0, k)).join('').trim()];
        }
        return all.filter((n) => n.beat <= upTo + 1e-6).map((n) => this.label(n));
      };
      // 지금 묶음(지정 묶음 또는 마디)의 노트만 쌓음
      const gr = this.subGroupOf(beat);
      if (gr) line(groupLine(gr, beat), 0);
      else {
        const key = this.subGroupKey(beat);
        line(labeled.filter((n) => this.subGroupKey(n.beat) === key).map((n) => this.label(n)), 0);
      }
      // 방금 끝난 묶음은 exit 방향으로 빠르게 미끄러져 나감
      for (const og of this.tpl.subtitleGroups ?? []) {
        const e = (beat - og.end) / EXIT_BEATS;
        if (!og.exit || e < 0 || e >= 1) continue;
        line(groupLine(og, og.end), (og.exit === 'left' ? -1 : 1) * W * e * e);
      }
    }

    if (scene.text === 'ticker') this.drawTicker(g, scene, beat);

    if (scene.text === 'trail') {
      const all = this.notes.filter((n) => n.beat >= scene.start && n.beat < scene.end && this.label(n) && !(scene.pip ?? []).includes(n.slot));
      const pMin = Math.min(...all.map((n) => n.pitch));
      const pMax = Math.max(...all.map((n) => n.pitch));
      const px = H * 0.065;
      const step = px * 1.05;
      const shift = Math.max(0, labeled.length * step - W * 0.9);
      labeled.forEach((n, i) => {
        const yN = pMax === pMin ? 0.5 : (n.pitch - pMin) / (pMax - pMin);
        const y = H * (0.72 - yN * 0.44);
        const x = W * 0.06 + i * step - shift;
        const age = (beat - n.beat) * spb(this.tpl);
        const s = 1 + 0.6 * Math.exp(-age * 14);
        outlined(g, this.label(n), x, y, px * s, color);
        outlined(g, this.label(n), x, H - y + H * 0.05, px, color, 0.35);
      });
    }

    if (scene.text === 'pop') {
      for (const n of labeled) {
        const age = beat - n.beat;
        const life = n.len + 0.75;
        if (age > life) continue;
        const r = hash(n.id);
        const size = H * (0.08 + r() * 0.09);
        const x = W * (0.15 + r() * 0.6);
        const y = H * (0.18 + r() * 0.5);
        const ageSec = age * spb(this.tpl);
        const s = 1 + 0.5 * Math.exp(-ageSec * 18);
        const alpha = age < n.len + 0.25 ? 1 : Math.max(0, 1 - (age - n.len - 0.25) / 0.5);
        const chars = [...this.label(n).replace(/\s/g, '')];
        chars.forEach((c, i) => outlined(g, c, x + i * size * 0.4, y + i * size * 0.9, size * s, color, alpha));
      }
    }

    if (scene.text === 'line') {
      let text = scene.lineText || labeled.map((n) => this.label(n)).join(' ');
      if (this.videoTest) {
        let i = 0;
        text = text.replace(/\S/g, () => placeholder(i++));
      }
      const total = this.notes.filter((n) => n.beat >= scene.start && n.beat < scene.end).length || 1;
      const shown = [...text].slice(0, Math.ceil(([...text].length * notes.length) / total)).join('');
      const px = H * 0.14;
      g.save();
      g.font = `900 ${px}px ${FONT}`;
      const tw = g.measureText(shown).width;
      g.restore();
      const x0 = Math.min(W * 0.03, W * 0.97 - tw);
      g.save();
      g.textAlign = 'left';
      outlined(g, shown, x0, H * 0.14, px, color, 0.75);
      g.restore();
    }

    if (scene.text === 'flash' && cur && this.label(cur) && cur.beat >= scene.start) {
      const lab = this.label(cur);
      const age = beat - cur.beat;
      const alpha = Math.max(0, 1 - age / (cur.len + 0.4));
      const px = Math.min(H * 0.85, (W * 0.9) / [...lab].length);
      g.save();
      g.globalAlpha = alpha * 0.85;
      g.font = `900 ${px}px ${FONT}`;
      g.fillStyle = color;
      g.fillText(lab, W / 2, H / 2);
      g.restore();
      const words = labeled.map((n) => this.label(n));
      g.font = `900 ${H * 0.055}px ${FONT}`;
      while (words.length > 1 && g.measureText(words.join(' ')).width > W * 0.92) words.shift();
      outlined(g, words.join(' '), W / 2, H * 0.92, H * 0.055, color);
    }
  }
}
