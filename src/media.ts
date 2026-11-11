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
  // 영상 길이: 템플릿 규격(videoSec) → video.durSec → 소리 길이 중 가장 긴 것. 최대 6초
  const dur = Math.min(6, Math.max(slot.videoSec ?? 0, slot.video?.durSec ?? slotAudioDur(slot)));
  const [buffer, sprite] = await Promise.all([
    slot.audio?.file ? backend.audio(ctx, slot.audio.file, slot.audio.inSec, slot.audio.outSec) : Promise.resolve(null),
    slot.video?.file ? backend.frames(slot.video.file, slot.video.inSec, dur, fw, fh) : Promise.resolve(null),
  ]);
  return { buffer, sprite };
}

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
  const sx = (i % sp.cols) * sp.w;
  const sy = Math.floor(i / sp.cols) * sp.h;
  g.drawImage(sp.img, sx, sy, sp.w, sp.h, dx, dy, dw, dh);
}
