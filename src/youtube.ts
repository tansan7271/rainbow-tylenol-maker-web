// 유튜브 원본 영상: IFrame Player API 로 띄우고, 우리 재생 시간에 맞춰 따라가게 한다.
// 유튜브는 프레임 단위로 정확히 맞출 수 없어서, 재생 중에 어긋남이 커지면 다시 맞추는 방식.
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(sec: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  setVolume(v: number): void;
  setPlaybackRate(r: number): void;
  mute(): void;
  unMute(): void;
}
declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: unknown) => YTPlayer };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiP: Promise<void> | null = null;
function loadApi() {
  apiP ??= new Promise<void>((res) => {
    if (window.YT?.Player) return res();
    window.onYouTubeIframeAPIReady = () => res();
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.append(s);
  });
  return apiP;
}

/** 비교 화면 원본 플레이어 공통 (유튜브 / 내 파일) */
export interface OrigPlayer {
  play(sec: number): Promise<void> | void;
  pause(): Promise<void> | void;
  show(sec: number): Promise<void> | void;
  follow(expected: number): void;
  setVolume(v: number, muted: boolean): void;
  setRate(r: number): Promise<void> | void;
}

/** 내 컴퓨터의 원본 영상 파일 (<video>) */
export class VideoSync implements OrigPlayer {
  constructor(private v: HTMLVideoElement) {}
  async play(sec: number) {
    this.v.currentTime = sec;
    await this.v.play().catch(() => {});
  }
  pause() {
    this.v.pause();
  }
  show(sec: number) {
    this.v.pause();
    this.v.currentTime = sec;
  }
  follow(expected: number) {
    if (!this.v.paused && !this.v.seeking && Math.abs(this.v.currentTime - expected) > 0.08) this.v.currentTime = expected;
  }
  setVolume(v: number, muted: boolean) {
    this.v.volume = Math.max(0, Math.min(1, v));
    this.v.muted = muted;
  }
  setRate(r: number) {
    this.v.playbackRate = r;
  }
}

export class YouTubeSync implements OrigPlayer {
  private player: YTPlayer | null = null;
  private ready: Promise<void>;
  private playing = false;
  private lastFix = 0;

  /** onError: 유튜브 오류 코드 (101/150 = 다른 사이트 재생 막힘, 100 = 영상 없음) */
  constructor(el: HTMLElement, videoId: string, onError?: (code: number) => void) {
    this.ready = loadApi().then(
      () =>
        new Promise<void>((res) => {
          this.player = new window.YT!.Player(el, {
            videoId,
            width: '100%',
            height: '100%',
            playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1 },
            events: { onReady: () => res(), onError: (e: { data: number }) => onError?.(e.data) },
          });
        }),
    );
  }
  whenReady() {
    return this.ready;
  }
  /** sec 부터 재생 */
  async play(sec: number) {
    await this.ready;
    this.player!.seekTo(sec, true);
    this.player!.playVideo();
    this.playing = true;
    this.lastFix = performance.now();
  }
  async pause() {
    await this.ready;
    this.player!.pauseVideo();
    this.playing = false;
  }
  /** 멈춘 상태에서 sec 화면으로 */
  async show(sec: number) {
    await this.ready;
    this.player!.seekTo(sec, true);
    this.player!.pauseVideo();
  }
  /** 재생 중 매 프레임 호출: 기대 시간과 0.12초 넘게 어긋나면 다시 맞춤 (너무 자주는 안 함) */
  follow(expected: number) {
    if (!this.player || !this.playing) return;
    const now = performance.now();
    if (now - this.lastFix < 700) return;
    const diff = this.player.getCurrentTime() - expected;
    if (Math.abs(diff) > 0.12) {
      this.player.seekTo(expected, true);
      this.lastFix = now;
    }
  }
  /** 유튜브 쪽 현재 시간(초). 준비 전이면 null */
  time() {
    return this.player ? this.player.getCurrentTime() : null;
  }
  isPlaying() {
    return this.playing;
  }
  async setRate(r: number) {
    await this.ready;
    this.player!.setPlaybackRate(r);
  }
  setVolume(v: number, muted: boolean) {
    if (!this.player) return;
    this.player.setVolume(Math.max(0, Math.min(100, v * 100)));
    muted ? this.player.mute() : this.player.unMute();
  }
}
