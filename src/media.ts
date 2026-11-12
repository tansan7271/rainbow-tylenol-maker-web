// 슬롯 클립(오디오 버퍼 + 프레임 스프라이트) 로딩. 실제 처리는 backend(브라우저/ffmpeg 모드)가 한다
import { backend, type Sprite } from './backend';
import { slotAudioDur, type Slot, type Template } from './types';

export type { Sprite };
export interface SlotAssets {
  buffer: AudioBuffer | null;
  sprite: Sprite | null;
}

export const fetchAudio = (ctx: BaseAudioContext, file: string, inSec?: number, outSec?: number, ch = 1) =>
  backend.audio(ctx, file, inSec, outSec, ch);

export async function loadSlotAssets(ctx: BaseAudioContext, tpl: Template, slot: Slot): Promise<SlotAssets> {
  const fw = Math.round(tpl.video.width / 2);
  const fh = Math.round(tpl.video.height / 2);
  // 영상 길이: 규격(videoSec) · video.durSec · 소리 길이 중 가장 긴 것. 6초 넘는 긴 구간은 성기게 뽑아서 최대 2분 (빨리 감기 몽타주용)
  const dur = Math.min(120, Math.max(slot.videoSec ?? 0, slot.video?.durSec ?? slotAudioDur(slot)));
  const [buffer, sprite] = await Promise.all([
    slot.audio?.file ? backend.audio(ctx, slot.audio.file, slot.audio.inSec, slot.audio.outSec) : Promise.resolve(null),
    slot.video?.file ? backend.frames(slot.video.file, slot.video.inSec, dur, fw, fh) : Promise.resolve(null),
  ]);
  return { buffer: buffer && slot.normalize ? normalized(buffer) : buffer, sprite };
}

/** 소리 크기 자동 맞춤: 클립의 소리 크기(RMS)를 일정하게, 단 최대치는 0.95 를 넘지 않게. 원본 캐시는 안 건드리고 새 버퍼로 */
function normalized(buf: AudioBuffer): AudioBuffer {
  let sum = 0;
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      sum += d[i] * d[i];
      peak = Math.max(peak, Math.abs(d[i]));
    }
  }
  const rms = Math.sqrt(sum / (buf.length * buf.numberOfChannels));
  if (rms < 1e-5) return buf;
  const k = Math.min(0.2 / rms, 0.95 / Math.max(peak, 1e-5)); // 목표 RMS 0.2
  const out = new AudioBuffer({ length: buf.length, sampleRate: buf.sampleRate, numberOfChannels: buf.numberOfChannels });
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < src.length; i++) dst[i] = src[i] * k;
  }
  return out;
}

/** 내보내기 1차: 어떤 스프라이트의 몇 번 프레임이 필요한지 모으기만 하고 그리지 않음 */
export const spriteUse: { collect: ((sp: Sprite, idx: number) => void) | null } = { collect: null };

export async function loadAllAssets(ctx: BaseAudioContext, tpl: Template, onError?: (slot: Slot, e: unknown) => void) {
  const map = new Map<string, SlotAssets>();
  await Promise.all(
    tpl.slots.map(async (s) => {
      try {
        map.set(s.id, await loadSlotAssets(ctx, tpl, s));
      } catch (e) {
        onError?.(s, e);
        map.set(s.id, { buffer: null, sprite: null });
      }
    }),
  );
  return map;
}

export function drawSpriteFrame(
  g: CanvasRenderingContext2D, sp: Sprite, idx: number, dx: number, dy: number, dw: number, dh: number,
) {
  const i = Math.max(0, Math.min(sp.count - 1, Math.floor(idx)));
  if (spriteUse.collect) return spriteUse.collect(sp, i);
  const hi = sp.hi?.get(i);
  if (hi) return g.drawImage(hi, dx, dy, dw, dh);
  const sx = (i % sp.cols) * sp.w;
  const sy = Math.floor(i / sp.cols) * sp.h;
  g.drawImage(sp.img, sx, sy, sp.w, sp.h, dx, dy, dw, dh);
}
