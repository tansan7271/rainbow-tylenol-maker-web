// 템플릿 = 곡 하나의 "포맷". 슬롯만 바꿔 끼우면 다른 밈 버전이 된다.

export interface VideoRef {
  file: string; // 프로젝트 루트 기준 상대경로 (또는 절대경로)
  inSec: number;
  durSec?: number; // 영상 길이(최대 6초). 없으면 소리 길이를 씀. 소리는 짧게 끊어 쓰고 화면은 길게 이어 틀 때 지정
}
export interface AudioRef {
  file: string;
  inSec: number;
  outSec: number;
}

export interface Slot {
  id: string;
  name: string;
  label: string; // 자막 글자. 비우면 기본 자리표시(가나다…)
  noSub?: boolean; // true = 자막에 안 나옴 / false = 글자를 비우면 기본 자리표시(가나다…) / 없으면 예전처럼 글자가 있을 때만
  noVideo?: boolean; // 추가 레이어 슬롯: 화면 없이 자막만 (소스가 없을 때 카드도 안 그림)
  videoSec?: number; // 규격: 화면에 이어 틀 영상 길이(초). 영상 프레임을 이만큼 뽑음 (최대 6초)
  audioSec?: number; // 규격(참고): 이 슬롯 소리 조각의 권장 길이(초) — 빈 슬롯에 소리를 처음 넣을 때 기본 길이
  color: string;
  video: VideoRef | null;
  audio: AudioRef | null; // 영상과 다른 파일이어도 됨 (효과음 따로 넣기)
  basePitch: number; // 클립 원래 음정 (MIDI 번호, 소수 허용)
  gain: number;
  mode: 'gate' | 'oneshot'; // gate: 노트 길이만큼만, oneshot: 클립 끝까지
  videoFollowsPitch: boolean; // 음이 높아지면 영상도 빨라짐 (고전 합필 스타일)
  videoSpeed?: 'normal' | 'pitch' | 'note' | 'shot'; // 영상 속도: 정상 / 음높이 따라 / 노트 길이에 맞춤(소리도 클립 전체를 노트 안에, 음높이는 노트대로) / 컷 길이에 맞춤(소리도). 없으면 videoFollowsPitch 로
  role?: 'lead' | 'backing' | 'overlay'; // backing = 반주 파트: 소리만 나고 메인 화면/자막은 안 바꿈
  // overlay = 추가 레이어 파트: 소리 + 노트마다 깜빡이는 좌우 PIP(높이=음높이) + 자체 자막. 메인 화면/자막은 안 바꿈
  layer?: 'pair' | 'quad'; // 화면 위에 한 겹 더 (overlay 는 기본 pair). quad = 이어진 노트 덩어리마다 좌하단 4분면에 클립 정상 재생 한 번
  quadSound?: 'once' | 'melody'; // 4분면 레이어 소리: once = 원래대로 한 번 길게(기본) / melody = 끊지 않고 이어서 틀되 노트마다 멜로디 음
  layerText?: string; // 레이어 자체 자막 (없으면 label)
  layerQuad?: 'tl' | 'tr' | 'bl' | 'br'; // quad 레이어 자리 (기본 bl = 좌하단)
  layerTextStyle?: 'slide' | 'bands'; // quad 자막: slide = 박스 옆에서 오른쪽으로 흐르며 사라짐(기본),
  //                                    bands = 화면 3등분 위 칸(크게·반투명, ←)·가운데 칸(작게, →)으로 흐름
  audioFrom?: string; // 이 슬롯 id 의 소리(클립·기준 음정)를 빌려 씀. 그 슬롯을 바꿔 끼우면 같이 바뀜
  audioFromAt?: [number, number]; // audioFrom 클립 안에서 이 구간(초)만 씀 (예: 긴 대사 안의 한 음절). 이때 기준 음정은 이 슬롯 basePitch
  /** 조각별 구간: 이어진 컷 흐름(C1 C2' C3…)의 n번째 컷이 클립의 어디를 쓸지 (초, 클립 시작 기준). 끝이 없으면 다음 조각 시작까지 */
  parts?: Record<number, { at: number; end?: number }>;
  pitchFx?: 'none' | 'vocoder' | 'resonance' | 'autotune'; // autotune = 목소리 음높이를 노트에 강제로 고정 (세기 = 0~1 얼마나 펼지) // 음정 입히기: 보코더(로봇 노래) / 공명(목소리 위로 음이 울림). 쓰면 말소리는 원래 속도
  normalize?: boolean; // 소리 크기 자동 맞춤 (조용한 클립을 키움, 깨지지 않게)
  reverb?: number; // 0~1 공간감(리버브). 뒤쪽에서 울리는 화음처럼
  soften?: number; // 0~1 부드럽게: 고음을 깎아 거친 소리를 누그러뜨림
  transpose?: number; // 이 슬롯 소리만 노트보다 반음 몇 개 올리거나 내림 (-12 = 한 옥타브 아래). 노트·화면은 그대로
  pitchFxAmount?: number; // 0~1 세기 (보코더 기본 0.9, 공명 기본 0.6)
  pitchFx2?: 'none' | 'vocoder' | 'resonance' | 'autotune'; // 뒤쪽 루프(template.loopSplit 부터)에서만 쓰는 음정 입히기. 없으면 앞과 같음
  pitchFxAmount2?: number;
  transpose2?: number; // 뒤쪽 루프에서만 쓰는 소리 높이 이동(반음). 없으면 앞과 같음
  clipAtOff?: boolean; // 틀에 있는 "같은 대사 다시 틀기"(컷·노트의 clipAt)를 무시하고 클립을 흐름대로 이어서
  audioTune?: boolean; // 오토튠처럼: 이어진 노트들이 클립을 처음부터가 아니라 이어서 틀고, 음높이만 노트를 따라감
  shotRestart?: boolean; // 화면 컷이 이어지는 흐름(C1 C2' C3…)이어도 컷마다 클립을 처음부터 다시 재생
}

export interface Note {
  id: string;
  beat: number; // 원곡 기준 박 위치
  len: number; // 박 단위
  pitch: number; // MIDI
  slot: string;
  vel: number;
  spot?: 'tl' | 'tr' | 'bl' | 'br'; // 추가 레이어 노트: 좌우 쌍 대신 이 4분면에 한 번 깜빡 (tl 좌상, br 우하…)
  spotBeats?: [number, number];
  clipAt?: number; // 오토튠 슬롯: 이 노트부터 클립의 이 위치(박)에서 다시 이어 틂 // 4분면 플래시가 화면에 보이는 구간(박). 없으면 노트 구간. 소리 타이밍은 그대로
}

export type Layout = 'full' | 'mirror' | 'split' | 'grid4';
export type TextStyle = 'none' | 'subtitle' | 'trail' | 'pop' | 'line' | 'flash' | 'ticker';
export type Fx = 'zoomPunch' | 'flipAlternate' | 'shake';

export interface Scene {
  start: number; // beat
  end: number;
  layout: Layout;
  text: TextStyle;
  pip?: string[]; // 구석 작은 화면으로 띄울 슬롯
  lineText?: string; // text === 'line' 일 때 큰 글씨 문장
  textColor?: string;
  fx?: Fx[];
  /** text === 'ticker' 일 때 출렁임을 직접 정함: [장면 안 몇 번째 노트(0부터), 띠 높이(화면 비율, 위 0 ~ 아래 1)].
   *  사이는 부드러운 가감속, 마지막 점으로는 가속해서 탁 멈춤. 없으면 멜로디가 꺾이는 노트를 따라감 */
  tickerKeys?: [number, number][];
}

/** 화면 컷: 이 구간 동안 화면은 노트와 상관없이 이 클립을 보여준다 */
export interface Shot {
  start: number; // beat
  end: number;
  slot: string; // 보여줄 슬롯 (노트의 슬롯 대신)
  flip?: boolean; // 좌우 반전 (A')
  flipV?: boolean; // 상하 반전 (A↕)
  clipAt?: number; // 컷 시작 때 클립의 이 위치(박)부터 재생 (같은 대사를 다시 틀거나 중간부터 이어 틀 때)
  part?: number; // 화면 표시 번호 (J1, J2…) 직접 지정
  over?: boolean; // 다른 컷 위에 덮어 그림: 시작에 팍 나타났다가 끝까지 서서히 사라짐
}

/** 하단 자막 묶음. text 를 적으면 슬롯 글자 대신 이 문장이 노트마다 한 글자씩 드러남 */
export interface SubtitleGroup {
  start: number; // beat
  end: number;
  exit?: 'left' | 'right';
  /** 노트마다 한 글자(띄어쓰기 유지). '/' 가 있으면 '/' 로 끊은 조각이 노트 하나씩. 남는 글자는 마지막 노트에서 한꺼번에 */
  text?: string;
  textFrom?: number; // 반복 구간: 이 번호(0부터) 묶음의 문장을 그대로 씀 (에디터에선 따로 입력 안 함)
}

/** 자막 칸: 에디터에서 한 번만 입력하면 그걸 쓰는 자막 이벤트들에 다 들어감 (여러 번 반복되는 글자, 한 칸씩 나뉘어 나오는 단어 등) */
export interface TextField {
  id: string;
  name: string; // 에디터 표시용 설명
  text: string;
}

/** 자막 이벤트: 장면 자막과 별개로 정해진 박·자리에 나오는 글자 (x, y 는 글자 중심, 화면 비율) */
export interface TextEvent {
  text?: string; // field 가 없을 때의 글자
  field?: string; // TextField.id — 그 칸의 문장을 씀
  unit?: number; // field 문장을 조각(글자마다, '/' 가 있으면 '/' 단위)으로 나눈 것 중 몇 번째(0부터)
  start: number; // beat
  end: number;
  x: number;
  y: number;
  from?: 'left' | 'right'; // 슉 들어오는 쪽 (그 반대 방향으로 흐름). 기본 left
  size?: number; // 글자 크기(화면 높이 비율), 기본 0.13 (static 은 0.08)
  font?: string; // static: 글꼴 (CSS font-family)
  weight?: number; // static: 굵기 (기본 400)
  literal?: boolean; // 영상 테스트·위장 표시에서도 가나다로 바꾸지 않고 그대로
  drift?: number; // swoosh: 들어온 뒤 흐르는 속도(초당 화면 폭), 기본 0.24
  anim?: 'swoosh' | 'burst' | 'band' | 'bounceRight' | 'spinArc' | 'static'; // static = 고정 자막(움직임·외곽선 없음, 짧게 페이드 인). // spinArc = 가로축으로 두 바퀴 돌며(원근 있음) 심장박동 곡선: 오른쪽 가운데 → 저점 (x, y) → 왼쪽 고점 → 왼쪽 가운데로 나감. // bounceRight = 오른쪽 정렬(x = 오른쪽 끝)로 튕기며 들어와 오른쪽으로 빠짐 + 만화식 말하는 표시. // band = from 쪽 밖에서 슝 들어와 천천히 흐르다 반대쪽으로 슝 나감. swoosh(기본) = from 쪽에서 슉 들어와 흐름 / burst = 그 자리에 크게 팟 뜨고 to 쪽으로 미끄러지며 사라짐
  to?: 'left' | 'right' | 'up' | 'down'; // burst 가 미끄러지는 쪽. 없으면 제자리에서 빠르게 페이드 인/아웃 (번쩍)
  alpha?: number; // burst 투명도 (기본: 미끄러짐 0.6, 제자리 0.45)
  snap?: { at: number; x: number; y: number }; // swoosh: 이 박에 이 자리로 슉 옮겨 가서 멈춤 (끝 0.25박 동안 사라짐)
  exitAt?: number; // tumble/fly 가 시작되는 박 (없으면 이벤트 길이의 절반 지점)
  exit?: 'fade' | 'tumble' | 'fly'; // fly = 화면 바깥쪽 대각선으로 가속하며 뻗어 나감 // 사라지는 방식: fade(기본) / tumble = 뒤로 누우며 소실점으로 쓕 멀어짐 (3D 회전)
  color?: string;
}

export interface Template {
  name: string;
  version: number;
  bpm: number;
  tuning?: number; // 원곡 튜닝 보정(센트). 모든 합성 음에 더해짐
  beatOffset: number; // 원곡 파일에서 beat 0 의 위치(초)
  beatsPerBar: number;
  barOffset: number; // 마디 시작 박
  song: { file: string; gain: number };
  reference?: { file: string; lag: number }; // (로컬판 전용) 원본 영상 파일
  youtube?: { id: string; lag: number }; // 비교용 유튜브 원본 (유튜브 시간 = 원곡 시간 + lag)
  range: { start: number; end: number };
  video: { width: number; height: number; fps: number };
  slots: Slot[];
  notes: Note[];
  scenes: Scene[];
  shots?: Shot[]; // 없거나 비어 있는 구간은 예전처럼 노트의 슬롯 영상
  /** 하단 자막 묶음(박 구간). 구간 안 노트들이 한 줄로 쌓이고 다음 묶음에서 새로 시작. 묶음 밖은 예전처럼 마디 단위.
   *  exit: 묶음이 끝나면(end) 그 방향으로 미끄러져 나감 */
  subtitleGroups?: SubtitleGroup[];
  loopSplit?: number; // 뒤쪽 루프가 시작하는 박 (슬롯의 pitchFx2 가 여기부터 적용)
  texts?: TextEvent[];
  textFields?: TextField[];
  fadeToBlack?: { start: number; end: number }; // 이 박부터 검은 화면으로 페이드, end 부터 완전히 검음 (자막은 그 위에)
}

export const spb = (t: Template) => 60 / t.bpm;
export const beatToSec = (t: Template, b: number) => t.beatOffset + b * spb(t);
export const secToBeat = (t: Template, s: number) => (s - t.beatOffset) / spb(t);

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const midiName = (m: number) => {
  const r = Math.round(m);
  return NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
};

export const slotAudioDur = (s: Slot) => (s.audio ? Math.max(0.01, s.audio.outSec - s.audio.inSec) : s.video?.durSec ?? 1);
export const pitchRate = (s: Slot, pitch: number) => Math.pow(2, (pitch - s.basePitch) / 12);

export const uid = () => Math.random().toString(36).slice(2, 9);
