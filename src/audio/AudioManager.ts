import Beatmap from "../beatmap/models/Beatmap";
import GameState from "../game/GameState";
import SettingsManager from "../settings/SettingsManager";
import AudioDataSource from "./AudioDataSource";
import GameAudioManager from "./GameAudioManager";
// eslint-disable-next-line @typescript-eslint/no-var-requires
import MidiPlayer from "./MidiPlayer";
export default class AudioManager implements AudioDataSource, GameAudioManager {
  audioContext: AudioContext;
  analyser: AnalyserNode;
  audioData: Uint8Array;

  beatmap: Beatmap;
  audioElement: HTMLMediaElement;

  hitSoundsEnabled: boolean;
  audioBuffers: Array<AudioBuffer>;
  listeners: Map<string, Array<() => void>>;

  midiPlayer: MidiPlayer;
  isMidiActive: boolean;

  constructor() {
    this.hitSoundsEnabled = true;
    this.audioBuffers = [null]; // first elem is null so sound ids start at 1
    this.listeners = new Map();
  }

  addEventListener(event: string, handler: () => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(handler);
  }

  broadcastEvent(event: string): void {
    if (this.listeners.has(event)) {
      for (const handler of this.listeners.get(event)) {
        handler();
      }
    }
  }

  init(settingsManager: SettingsManager): void {
    this.hitSoundsEnabled = settingsManager.getSettingValue("hitSoundsEnabled");
    if (this.hitSoundsEnabled == null) {
      this.hitSoundsEnabled = true;
    }
    settingsManager.addObserver("hitSoundsEnabled", (value) => {
      this.hitSoundsEnabled = value;
      this.startContext();
    });
    this.audioElement = new Audio();
    this.audioElement.volume = 0.5;
    this.audioElement.addEventListener("ended", () => {
      this.broadcastEvent("songEnd");
    });

    if (AudioContext) {
      this.audioContext = new AudioContext();
      this.analyser = this.audioContext.createAnalyser();
      this.audioContext
        .createMediaElementSource(this.audioElement)
        .connect(this.analyser);
      this.analyser.connect(this.audioContext.destination);
      this.audioData = new Uint8Array(this.analyser.frequencyBinCount);
      this.midiPlayer = new MidiPlayer(this.audioContext);
      this.midiPlayer.addEventListener("ended", () => {
        this.broadcastEvent("songEnd");
      });
    } else {
      console.error("AudioContext not supported");
    }
  }

  async startContext(): Promise<void> {
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
  }

  async loadMidiBeatmap(beatmap: Beatmap): Promise<void> {
    const midiFile = await fetch(beatmap.set.info.audioSrc).then((res) =>
      res.arrayBuffer()
    );
    await this.midiPlayer.loadArrayBuffer(midiFile);
  }

  async loadBeatmap(beatmap: Beatmap): Promise<void> {
    this.beatmap = beatmap;
    if (beatmap.set.info.srcFormat === "midi") {
      await this.loadMidiBeatmap(beatmap);
      this.isMidiActive = true;
    } else {
      this.audioElement.src = beatmap.set.info.audioSrc;
      this.audioElement.load();
      this.isMidiActive = false;
    }
    const sounds = beatmap.set.info.sounds;
    if (sounds) {
      const soundIds = [];
      for (let i = 0; i < sounds.length; i++) {
        const soundId = await fetch(sounds[i])
          .then((res) => res.arrayBuffer())
          .then((audioData) => {
            return this.registerSound(audioData);
          });
        soundIds.push(soundId);
      }
      for (const note of beatmap.notes) {
        if (note.sound != null) {
          note.sound = soundIds[note.sound];
        }
      }
    }
  }

  async onGameStart(): Promise<number> {
    await this.startContext();
    if (this.isMidiActive) {
      return await this.midiPlayer.play();
    } else {
      await this.audioElement.play();
    }
    return this.audioContext.currentTime;
  }

  onGamePause(): void {
    if (this.isMidiActive) {
      this.midiPlayer.pause();
    } else {
      this.audioElement.pause();
    }
  }

  async onGameResume(): Promise<number> {
    if (this.isMidiActive) {
      return await this.midiPlayer.resume();
    }
    await this.audioElement.play();
    return this.audioContext.currentTime;
  }

  async onGameRestart(): Promise<number> {
    this.audioElement.pause();
    this.audioElement.currentTime = 0;
    if (this.isMidiActive) {
      this.midiPlayer.reset();
      await this.midiPlayer.play();
    } else {
      await this.audioElement.play();
    }
    return this.audioContext.currentTime;
  }

  update(gamestate: GameState): void {
    for (const hitEvent of gamestate.events) {
      if (
        hitEvent.note.sound &&
        !hitEvent.note.isActive &&
        hitEvent.judgement
      ) {
        this.playHitSound(hitEvent.note.sound);
      }
    }
  }

  async registerSoundFromUrl(url: string): Promise<number> {
    const audioData = await fetch(url).then((res) => res.arrayBuffer());
    return this.registerSound(audioData);
  }

  async registerSound(audioData: ArrayBuffer): Promise<number> {
    await this.audioContext.decodeAudioData(audioData, (buffer) => {
      this.audioBuffers.push(buffer);
    });
    return this.audioBuffers.length - 1;
  }

  playHitSound(id: number): void {
    if (this.hitSoundsEnabled) {
      this.playSound(id);
    }
  }

  playSound(id: number): void {
    const buffer = this.audioBuffers[id];
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);
    source.start();
  }
}
