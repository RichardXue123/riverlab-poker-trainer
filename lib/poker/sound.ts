export type PokerSound = "deal" | "check" | "chips" | "fold" | "all-in" | "turn" | "win";

let audioContext: AudioContext | undefined;

function getContext(): AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  const AudioContextClass = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return undefined;
  audioContext ??= new AudioContextClass();
  return audioContext;
}

function tone(
  context: AudioContext,
  destination: AudioNode,
  frequency: number,
  start: number,
  duration: number,
  gain: number,
  type: OscillatorType = "sine",
  endFrequency?: number,
) {
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(gain, start + 0.008);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(envelope).connect(destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.01);
}

export async function unlockPokerAudio(): Promise<void> {
  const context = getContext();
  if (context?.state === "suspended") await context.resume();
}

export function playPokerSound(sound: PokerSound, volume: number): void {
  const context = getContext();
  if (!context || context.state !== "running" || volume <= 0) return;
  const master = context.createGain();
  master.gain.value = Math.max(0, Math.min(1, volume)) * 0.18;
  master.connect(context.destination);
  const now = context.currentTime + 0.005;

  if (sound === "deal") {
    tone(context, master, 310, now, 0.07, 0.55, "triangle", 155);
    tone(context, master, 260, now + 0.075, 0.07, 0.45, "triangle", 130);
  } else if (sound === "check") {
    tone(context, master, 760, now, 0.045, 0.38, "square", 520);
  } else if (sound === "chips") {
    tone(context, master, 1250, now, 0.045, 0.4, "triangle", 830);
    tone(context, master, 1580, now + 0.045, 0.055, 0.32, "triangle", 1040);
  } else if (sound === "fold") {
    tone(context, master, 230, now, 0.11, 0.42, "triangle", 95);
  } else if (sound === "all-in") {
    tone(context, master, 196, now, 0.18, 0.48, "sawtooth", 392);
    tone(context, master, 294, now + 0.07, 0.18, 0.38, "triangle", 588);
  } else if (sound === "turn") {
    tone(context, master, 660, now, 0.09, 0.35, "sine");
    tone(context, master, 880, now + 0.11, 0.12, 0.35, "sine");
  } else {
    tone(context, master, 392, now, 0.13, 0.4, "sine");
    tone(context, master, 523, now + 0.11, 0.13, 0.4, "sine");
    tone(context, master, 659, now + 0.22, 0.2, 0.45, "sine");
  }
}
