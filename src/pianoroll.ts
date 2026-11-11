// 피아노롤: 노트(어느 슬롯이 어떤 음을 언제) + 장면 레인 + 눈금자
import { shownLabel } from './stealth';
import { midiName, uid, type Note, type Template } from './types';

export interface RollHost {
  tpl(): Template;
  currentSlot(): string;
  beginEdit(): void; // 변경 직전 (undo 스냅샷)
  changed(): void; // 변경 후
  seek(beat: number): void;
  audition(n: Note): void;
  selectScene(i: number | null): void;
  selectionChanged(): void;
}

const RULER = 20;
const LANE = 24;
const HEAD = RULER + LANE;
const KEYS = 46;
const TEXT_COLORS: Record<string, string> = {
  none: '#495057', subtitle: '#1c7ed6', trail: '#e8590c', pop: '#2f9e44', line: '#9c36b5', flash: '#c92a2a',
};

type Drag =
  | { kind: 'seek' }
  | { kind: 'move'; startBeat: number; startPitch: number; orig: Map<string, { beat: number; pitch: number }>; moved: boolean }
  | { kind: 'resize'; orig: Map<string, number>; startBeat: number }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number; base: Set<string> }
  | { kind: 'sceneEdge'; i: number }
  | { kind: 'pan'; x0: number; y0: number; sb: number; tp: number };

export class PianoRoll {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  ppb = 56; // px per beat
  rowH = 12;
  scrollBeat = 30;
  topPitch = 92;
  snap = 0.25;
  lastLen = 0.25;
  playhead = 0;
  follow = true;
  selected = new Set<string>();
  selectedScene: number | null = null;
  private drag: Drag | null = null;
  private dpr = 1;

  constructor(private host: RollHost, parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'roll';
    parent.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(parent);
    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    this.canvas.addEventListener('pointerup', (e) => this.up(e));
    this.canvas.addEventListener('dblclick', (e) => this.dbl(e));
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const n = this.hit(e.offsetX, e.offsetY);
      if (n) this.deleteNotes([n.id]);
    });
    this.canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
  }

  private get W() { return this.canvas.width / this.dpr; }
  private get H() { return this.canvas.height / this.dpr; }
  private tpl() { return this.host.tpl(); }
  x(b: number) { return KEYS + (b - this.scrollBeat) * this.ppb; }
  beatAt(x: number) { return (x - KEYS) / this.ppb + this.scrollBeat; }
  y(p: number) { return HEAD + (this.topPitch - p) * this.rowH; }
  pitchAt(y: number) { return Math.floor(this.topPitch - (y - HEAD) / this.rowH) + 1; }
  snapBeat(b: number) { return Math.round(b / this.snap) * this.snap; }

  resize() {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, r.width * this.dpr);
    this.canvas.height = Math.max(1, r.height * this.dpr);
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.draw();
  }

  centerOnNotes() {
    const ns = this.tpl().notes;
    if (!ns.length) return;
    const ps = ns.map((n) => n.pitch).sort((a, b) => a - b);
    const mid = ps[Math.floor(ps.length / 2)];
    const rows = (this.H - HEAD) / this.rowH;
    this.topPitch = Math.round(mid + rows / 2);
    this.scrollBeat = this.tpl().range.start - 0.5;
    this.draw();
  }

  setPlayhead(b: number) {
    this.playhead = b;
    if (this.follow) {
      const right = this.beatAt(this.W - 40);
      if (b > right || b < this.scrollBeat) this.scrollBeat = b - 1;
    }
    this.draw();
  }

  hit(x: number, y: number): Note | undefined {
    if (y < HEAD || x < KEYS) return;
    const b = this.beatAt(x);
    const p = this.pitchAt(y);
    const ns = this.tpl().notes;
    for (let i = ns.length - 1; i >= 0; i--) {
      const n = ns[i];
      if (n.pitch === p && b >= n.beat && b <= n.beat + n.len) return n;
    }
  }

  private sceneEdgeAt(x: number) {
    const sc = this.tpl().scenes;
    for (let i = 1; i < sc.length; i++) if (Math.abs(this.x(sc[i].start) - x) < 5) return i;
    return -1;
  }

  private down(e: PointerEvent) {
    this.canvas.setPointerCapture(e.pointerId);
    const { offsetX: x, offsetY: y } = e;
    const tpl = this.tpl();
    if (e.button === 1) {
      this.drag = { kind: 'pan', x0: x, y0: y, sb: this.scrollBeat, tp: this.topPitch };
      return;
    }
    if (e.button !== 0) return;
    if (y < RULER) {
      this.drag = { kind: 'seek' };
      this.host.seek(Math.max(0, this.beatAt(x)));
      return;
    }
    if (y < HEAD) {
      const edge = this.sceneEdgeAt(x);
      if (edge > 0) {
        this.host.beginEdit();
        this.drag = { kind: 'sceneEdge', i: edge };
        return;
      }
      const b = this.beatAt(x);
      const i = tpl.scenes.findIndex((s) => b >= s.start && b < s.end);
      this.selectedScene = i >= 0 ? i : null;
      this.host.selectScene(this.selectedScene);
      this.draw();
      return;
    }
    if (x < KEYS) return;
    const n = this.hit(x, y);
    if (n) {
      if (e.shiftKey) {
        if (this.selected.has(n.id)) this.selected.delete(n.id);
        else this.selected.add(n.id);
      } else if (!this.selected.has(n.id)) {
        this.selected = new Set([n.id]);
      }
      this.host.selectionChanged();
      this.host.beginEdit();
      if (e.altKey) {
        // 옵션 드래그 = 복제
        const clones = tpl.notes.filter((m) => this.selected.has(m.id)).map((m) => ({ ...m, id: uid() }));
        tpl.notes.push(...clones);
        this.selected = new Set(clones.map((c) => c.id));
      }
      const sel = tpl.notes.filter((m) => this.selected.has(m.id));
      if (this.x(n.beat + n.len) - x < 7) {
        this.drag = { kind: 'resize', startBeat: this.beatAt(x), orig: new Map(sel.map((m) => [m.id, m.len])) };
      } else {
        this.drag = {
          kind: 'move', startBeat: this.beatAt(x), startPitch: this.pitchAt(y), moved: false,
          orig: new Map(sel.map((m) => [m.id, { beat: m.beat, pitch: m.pitch }])),
        };
        this.host.audition(n);
      }
      this.draw();
      return;
    }
    if (e.shiftKey) {
      this.drag = { kind: 'box', x0: x, y0: y, x1: x, y1: y, base: new Set(this.selected) };
      return;
    }
    // 빈 곳 클릭 = 새 노트
    this.host.beginEdit();
    const note: Note = {
      id: uid(), beat: Math.floor(this.beatAt(x) / this.snap) * this.snap, len: this.lastLen,
      pitch: this.pitchAt(y), slot: this.host.currentSlot(), vel: 1,
    };
    tpl.notes.push(note);
    this.selected = new Set([note.id]);
    this.host.selectionChanged();
    this.host.audition(note);
    this.drag = { kind: 'resize', startBeat: note.beat + note.len, orig: new Map([[note.id, note.len]]) };
    this.draw();
  }

  private move(e: PointerEvent) {
    const { offsetX: x, offsetY: y } = e;
    if (!this.drag) {
      const edge = y >= RULER && y < HEAD && this.sceneEdgeAt(x) > 0;
      const n = this.hit(x, y);
      this.canvas.style.cursor = edge || (n && this.x(n.beat + n.len) - x < 7) ? 'ew-resize' : n ? 'grab' : 'default';
      return;
    }
    const tpl = this.tpl();
    const d = this.drag;
    if (d.kind === 'seek') this.host.seek(Math.max(0, this.beatAt(x)));
    else if (d.kind === 'pan') {
      this.scrollBeat = d.sb - (x - d.x0) / this.ppb;
      this.topPitch = Math.round(d.tp + (y - d.y0) / this.rowH);
    } else if (d.kind === 'move') {
      const db = this.snapBeat(this.beatAt(x) - d.startBeat);
      const dp = this.pitchAt(y) - d.startPitch;
      for (const n of tpl.notes) {
        const o = d.orig.get(n.id);
        if (!o) continue;
        const newPitch = o.pitch + dp;
        if (newPitch !== n.pitch && n.id === [...d.orig.keys()][0]) this.host.audition({ ...n, pitch: newPitch });
        n.beat = Math.max(0, o.beat + db);
        n.pitch = newPitch;
      }
      d.moved = true;
    } else if (d.kind === 'resize') {
      const db = this.snapBeat(this.beatAt(x) - d.startBeat);
      for (const n of tpl.notes) {
        const o = d.orig.get(n.id);
        if (o != null) n.len = Math.max(this.snap / 2, o + db);
      }
    } else if (d.kind === 'box') {
      d.x1 = x;
      d.y1 = y;
      const b0 = this.beatAt(Math.min(d.x0, x));
      const b1 = this.beatAt(Math.max(d.x0, x));
      const p0 = this.pitchAt(Math.max(d.y0, y));
      const p1 = this.pitchAt(Math.min(d.y0, y));
      this.selected = new Set(d.base);
      for (const n of tpl.notes) if (n.beat + n.len > b0 && n.beat < b1 && n.pitch >= p0 && n.pitch <= p1) this.selected.add(n.id);
    } else if (d.kind === 'sceneEdge') {
      const sc = tpl.scenes;
      const b = this.snapBeat(this.beatAt(x));
      const lo = sc[d.i - 1].start + this.snap;
      const hi = sc[d.i].end - this.snap;
      sc[d.i].start = sc[d.i - 1].end = Math.min(hi, Math.max(lo, b));
    }
    this.draw();
  }

  private up(_e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'resize') {
      const n = this.tpl().notes.find((m) => d.orig.has(m.id));
      if (n) this.lastLen = n.len;
    }
    if (d.kind === 'box') this.host.selectionChanged();
    if (d.kind === 'move' || d.kind === 'resize' || d.kind === 'sceneEdge') this.host.changed();
    this.draw();
  }

  private dbl(e: MouseEvent) {
    const n = this.hit(e.offsetX, e.offsetY);
    if (n) this.deleteNotes([n.id]);
  }

  deleteNotes(ids: string[]) {
    if (!ids.length) return;
    this.host.beginEdit();
    const s = new Set(ids);
    const tpl = this.tpl();
    tpl.notes = tpl.notes.filter((n) => !s.has(n.id));
    ids.forEach((i) => this.selected.delete(i));
    this.host.selectionChanged();
    this.host.changed();
    this.draw();
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const b = this.beatAt(e.offsetX);
      this.ppb = Math.min(400, Math.max(8, this.ppb * Math.exp(-e.deltaY * 0.01)));
      this.scrollBeat = b - (e.offsetX - KEYS) / this.ppb;
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      this.scrollBeat += (e.shiftKey ? e.deltaY : e.deltaX) / this.ppb;
    } else {
      this.topPitch = Math.min(120, Math.max(20, this.topPitch - Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 20))));
    }
    this.draw();
  }

  draw() {
    const g = this.g;
    const tpl = this.tpl();
    if (!tpl) return;
    const W = this.W;
    const H = this.H;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = '#16181d';
    g.fillRect(0, 0, W, H);

    // 행 배경
    const pLo = this.pitchAt(H) - 1;
    for (let p = this.topPitch; p >= pLo; p--) {
      const black = [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
      g.fillStyle = black ? '#1b1e24' : '#22262e';
      g.fillRect(KEYS, this.y(p), W - KEYS, this.rowH - 1);
    }
    // 범위 밖 어둡게
    g.fillStyle = 'rgba(0,0,0,0.45)';
    const rx0 = this.x(tpl.range.start);
    const rx1 = this.x(tpl.range.end);
    if (rx0 > KEYS) g.fillRect(KEYS, HEAD, rx0 - KEYS, H - HEAD);
    if (rx1 < W) g.fillRect(Math.max(KEYS, rx1), HEAD, W - rx1, H - HEAD);

    // 세로선
    const b0 = Math.floor(this.scrollBeat);
    const b1 = Math.ceil(this.beatAt(W));
    const sub = this.ppb > 90 ? 0.25 : this.ppb > 40 ? 0.5 : 1;
    for (let b = b0; b <= b1; b += sub) {
      const x = this.x(b);
      if (x < KEYS) continue;
      const isBar = Number.isInteger(b) && (((b - tpl.barOffset) % tpl.beatsPerBar) + tpl.beatsPerBar) % tpl.beatsPerBar === 0;
      g.fillStyle = isBar ? '#5c6370' : Number.isInteger(b) ? '#3a3f4a' : '#2a2e36';
      g.fillRect(Math.round(x), HEAD, 1, H - HEAD);
    }

    // 노트
    const slotMap = new Map(tpl.slots.map((s) => [s.id, s]));
    g.font = '10px sans-serif';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    for (const n of tpl.notes) {
      const x = this.x(n.beat);
      const w = Math.max(3, n.len * this.ppb - 1);
      const y = this.y(n.pitch);
      if (x + w < KEYS || x > W || y + this.rowH < HEAD || y > H) continue;
      const s = slotMap.get(n.slot);
      g.fillStyle = s?.color ?? '#888';
      g.globalAlpha = s?.role === 'backing' ? 0.55 : 1;
      g.fillRect(x, y, w, this.rowH - 1);
      g.globalAlpha = 1;
      if (this.selected.has(n.id)) {
        g.strokeStyle = '#fff';
        g.lineWidth = 2;
        g.strokeRect(x + 1, y + 1, w - 2, this.rowH - 3);
      }
      const lab = shownLabel(tpl, s);
      if (w > 14 && lab) {
        g.fillStyle = '#000';
        g.save();
        g.beginPath();
        g.rect(x, y, w, this.rowH);
        g.clip();
        g.fillText(lab, x + 2, y + this.rowH / 2);
        g.restore();
      }
    }

    // 박스 선택
    if (this.drag?.kind === 'box') {
      const d = this.drag;
      g.strokeStyle = '#74c0fc';
      g.lineWidth = 1;
      g.setLineDash([4, 3]);
      g.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      g.setLineDash([]);
    }

    // 왼쪽 건반
    g.fillStyle = '#101114';
    g.fillRect(0, HEAD, KEYS, H - HEAD);
    for (let p = this.topPitch; p >= pLo; p--) {
      const pc = ((p % 12) + 12) % 12;
      const black = [1, 3, 6, 8, 10].includes(pc);
      g.fillStyle = black ? '#2b2f36' : '#d8dce3';
      g.fillRect(0, this.y(p), black ? KEYS * 0.62 : KEYS - 2, this.rowH - 1);
      if (pc === 0) {
        g.fillStyle = '#222';
        g.fillText(midiName(p), KEYS - 26, this.y(p) + this.rowH / 2);
      }
    }

    // 장면 레인
    g.fillStyle = '#0d0e11';
    g.fillRect(0, 0, W, HEAD);
    tpl.scenes.forEach((s, i) => {
      const x0 = Math.max(KEYS, this.x(s.start));
      const x1 = this.x(s.end);
      if (x1 < KEYS || x0 > W) return;
      g.fillStyle = TEXT_COLORS[s.text] ?? '#555';
      g.globalAlpha = this.selectedScene === i ? 1 : 0.6;
      g.fillRect(x0, RULER + 2, x1 - x0 - 1, LANE - 4);
      g.globalAlpha = 1;
      if (this.selectedScene === i) {
        g.strokeStyle = '#fff';
        g.lineWidth = 2;
        g.strokeRect(x0 + 1, RULER + 3, x1 - x0 - 3, LANE - 6);
      }
      g.save();
      g.beginPath();
      g.rect(x0, RULER, x1 - x0 - 2, LANE);
      g.clip();
      g.fillStyle = '#fff';
      g.fillText(`${s.layout}·${s.text}${s.pip?.length ? '·PIP' : ''}${s.fx?.length ? '·' + s.fx.join(',') : ''}`, x0 + 4, RULER + LANE / 2);
      g.restore();
    });

    // 눈금자
    g.fillStyle = '#08090b';
    g.fillRect(0, 0, W, RULER);
    g.fillStyle = '#adb5bd';
    const bpb = tpl.beatsPerBar;
    for (let b = b0 + ((((tpl.barOffset - b0) % bpb) + bpb) % bpb); b <= b1; b += bpb) {
      const x = this.x(b);
      if (x < KEYS) continue;
      g.fillRect(x, 10, 1, RULER - 10);
      g.fillText(String(Math.floor((b - tpl.barOffset) / tpl.beatsPerBar) + 1), x + 3, 8);
    }
    g.fillStyle = '#ffd43b';
    g.fillText('range', Math.max(KEYS, rx0) + 3, RULER - 4);

    // 재생 헤드
    const px = this.x(this.playhead);
    if (px >= KEYS && px <= W) {
      g.fillStyle = '#ffd43b';
      g.fillRect(Math.round(px), 0, 2, H);
    }
    g.fillStyle = '#101114';
    g.fillRect(0, 0, KEYS, HEAD);
  }
}
