// 알림음: 소리 파일 없이 Web Audio 로 '딩동' 두 음을 낸다.
// 브라우저는 사용자가 화면을 한 번 누르기 전에는 소리를 막으므로, 첫 터치·클릭·키 입력 때 오디오를 깨워 둔다.

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (ctx) return ctx;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  return ctx;
}

function unlock() {
  const c = getCtx();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}
for (const ev of ['pointerdown', 'touchstart', 'keydown'] as const) {
  window.addEventListener(ev, unlock, { capture: true, passive: true });
}

function tone(c: AudioContext, freq: number, start: number, dur: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.5, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}

/** 딩동 (두 번 반복). 화면을 한 번도 누르지 않은 상태에서는 브라우저가 막아 소리가 나지 않을 수 있다. */
export function playChime() {
  const c = getCtx();
  if (!c) return;
  const play = () => {
    const t = c.currentTime + 0.05;
    for (const off of [0, 0.9]) {
      tone(c, 988, t + off, 0.45); // 시
      tone(c, 784, t + off + 0.3, 0.6); // 솔
    }
  };
  if (c.state === 'suspended') c.resume().then(play).catch(() => {});
  else play();
}
