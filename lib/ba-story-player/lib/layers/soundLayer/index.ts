import eventBus from "@/eventBus";
import { usePlayerStore } from "@/stores";
import { Howl, Howler } from "howler";
import { watch } from "vue";
import { useUiState } from "@/stores/state";
import { PlayAudio } from "@/types/events";
import { BGMExcelTableItem } from "@/types/excels";

const audioMap = new Map<string, Howl>();
const audioBlobUrls = new Map<string, string>();
const AUDIO_PRELOAD_CONCURRENCY = 8;
const AUDIO_PRELOAD_ATTEMPTS = 3;

function audioFormat(url: string): string[] | undefined {
  const extension = url.split(/[?#]/u)[0].match(/\.([a-z0-9]+)$/iu)?.[1]
    .toLowerCase();
  if (!extension) return undefined;
  if (extension === "mpeg") return ["mp3"];
  if (["mp3", "ogg", "opus", "wav", "webm"].includes(extension)) {
    return [extension];
  }
  return undefined;
}

async function downloadAudio(url: string): Promise<void> {
  if (audioBlobUrls.has(url)) return;

  let lastError: unknown;
  for (let attempt = 1; attempt <= AUDIO_PRELOAD_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const blobUrl = URL.createObjectURL(await response.blob());
      const previous = audioBlobUrls.get(url);
      if (previous) {
        URL.revokeObjectURL(blobUrl);
      } else {
        audioBlobUrls.set(url, blobUrl);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < AUDIO_PRELOAD_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      }
    }
  }
  throw lastError;
}

/**
 * Download story audio before playback without decoding every clip at once.
 * Playback Howls are created lazily from the downloaded Blob URLs, so dialogue
 * transitions do not wait for another network request.
 */
export async function preloadAudioUrls(urls: string[]): Promise<void> {
  const queue = [...new Set(urls.filter(Boolean))].filter(
    url => !audioBlobUrls.has(url)
  );
  const failures: Array<{ url: string; error: unknown }> = [];
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < queue.length) {
      const url = queue[nextIndex++];
      try {
        await downloadAudio(url);
        eventBus.emit("oneResourceLoaded", {
          type: "success",
          resourceName: url,
        });
      } catch (error) {
        failures.push({ url, error });
        eventBus.emit("oneResourceLoaded", {
          type: "fail",
          resourceName: url,
        });
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(AUDIO_PRELOAD_CONCURRENCY, queue.length) },
      worker
    )
  );
  if (failures.length) {
    throw new AggregateError(
      failures.map(item => item.error),
      `Failed to preload ${failures.length} audio resources`
    );
  }
}
/**
 * 获取url对于的Sound对象, 缓存不存在则新建
 * @param url
 */
function getAudio(url: string): Howl {
  const audio = audioMap.get(url);
  if (audio) {
    return audio;
  } else {
    const newAudio = new Howl({
      src: [audioBlobUrls.get(url) || url],
      format: audioFormat(url),
      autoplay: false,
      preload: true,
    });
    audioMap.set(url, newAudio);
    return newAudio;
  }
}

export function soundDispose() {
  for (const sound of audioMap.values()) {
    sound.stop();
  }
  Howler.stop();
}

function soundUnload() {
  soundDispose();
  for (const sound of audioMap.values()) {
    sound.unload();
  }
  audioMap.clear();
  for (const blobUrl of audioBlobUrls.values()) {
    URL.revokeObjectURL(blobUrl);
  }
  audioBlobUrls.clear();
}

/**
 * 初始化声音层, 订阅player的剧情信息.
 */
export function soundInit() {
  let bgm: Howl | undefined = undefined;
  let sfx: Howl | undefined = undefined;
  let voice: Howl | undefined = undefined;
  let emotionSound: Howl | undefined = undefined;
  const UiState = useUiState();
  function channelVolume(
    channel: "bgmVolume" | "sfxVolume" | "voiceVolume"
  ): number {
    if (UiState.runtimeMuted.value) {
      return 0;
    }
    const vol = UiState.volume.value;
    return (vol.masterVolume ?? 1) * vol[channel];
  }
  watch(
    () => [UiState.volume.value, UiState.runtimeMuted.value],
    () => {
      if (bgm) {
        bgm.volume(channelVolume("bgmVolume"));
      }
      if (sfx) {
        sfx.volume(channelVolume("sfxVolume"));
      }
      if (voice) {
        voice.volume(channelVolume("voiceVolume"));
      }
      if (emotionSound) {
        emotionSound.volume(channelVolume("sfxVolume"));
      }
    },
    { deep: true }
  );
  /**
   * @description 播放声音
   * @param playAudioInfo
   */
  function playAudio(playAudioInfo: PlayAudio) {
    if (playAudioInfo.bgm) {
      // 如果有正在播放的BGM则停止当前播放, 替换为下一个BGM
      const cfg = playAudioInfo.bgm;
      const self = getAudio(cfg.url);
      // eslint-disable-next-line no-inner-declarations
      function endCb() {
        bgm?.off("end", endCb);
        if (Reflect.get(bgm || {}, "_src") === cfg.url) {
          self.play("loop");
        }
      }
      new Promise<typeof cfg>((resovle, reject) => {
        if (bgm) {
          // 如果正在播放的bgm和新的是同一个，直接跳过?? 是否合理
          if (Reflect.get(bgm, "_src") === cfg.url) {
            reject("");
            return;
          }
          bgm.stop();
          bgm.off("end", endCb);
          bgm = undefined;
        }
        resovle(cfg);
      })
        .then(cfg => {
          // 替换BGM
          bgm = self;
          const state = Reflect.get(self, "_state");
          function setLoop() {
            const sprite = Reflect.get(self, "_sprite");
            let loopStartTime: (number | undefined)[] = [];
            let loopEndTime: (number | undefined)[] = [];

            if (Array.isArray(cfg.bgmArgs.LoopStartTime)) {
              loopStartTime = cfg.bgmArgs.LoopStartTime;
            } else {
              // 旧版bgm配置
              loopStartTime = [cfg.bgmArgs.LoopStartTime];
            }

            if (Array.isArray(cfg.bgmArgs.LoopEndTime)) {
              loopEndTime = cfg.bgmArgs.LoopEndTime;
            } else {
              // 旧版bgm配置
              loopEndTime = [cfg.bgmArgs.LoopEndTime];
            }

            if (sprite) {
              // eslint-disable-next-line max-len
              Reflect.set(sprite, "loop", [
                (loopStartTime[0] ?? 0) * 1000,
                (loopEndTime[0] || self.duration()) * 1000,
                true,
              ]);
            } else {
              // eslint-disable-next-line max-len
              Reflect.set(sprite, "_sprite", {
                loop: [
                  (loopStartTime[0] ?? 0) * 1000,
                  (loopEndTime[0] || self.duration()) * 1000,
                  true,
                ],
              });
            }
          }
          if (state !== "loaded") {
            bgm.once("load", () => {
              setLoop();
            });
          } else {
            setLoop();
          }
          bgm.seek(0);
          bgm.once("end", endCb);
          bgm.volume(channelVolume("bgmVolume"));
          bgm.play();
        })
        .catch(err => {
          if (err && typeof err !== "string") {
            console.log(err);
          }
        });
    }
    if (playAudioInfo.soundUrl) {
      if (sfx) {
        sfx.stop();
      }
      sfx = getAudio(playAudioInfo.soundUrl);
      sfx.volume(channelVolume("sfxVolume"));
      sfx.once("end", () => {
        eventBus.emit("playSFXDone", playAudioInfo.soundUrl || "");
      });
      sfx.play();
    }

    if (playAudioInfo.voiceJPUrl) {
      if (voice) {
        voice.off("end");
        voice.off("loaderror");
        voice.off("playerror");
        voice.stop();
      }
      const voiceUrl = playAudioInfo.voiceJPUrl;
      voice = getAudio(voiceUrl);
      const currentVoice = voice;
      let settled = false;
      const cleanup = () => {
        currentVoice.off("end", handleEnd);
        currentVoice.off("loaderror", handleError);
        currentVoice.off("playerror", handleError);
      };
      const handleEnd = () => {
        if (settled) return;
        settled = true;
        cleanup();
        eventBus.emit("playVoiceJPDone", voiceUrl);
      };
      const handleError = (_id: number, error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        eventBus.emit("playVoiceJPError", { url: voiceUrl, error });
      };
      currentVoice.volume(channelVolume("voiceVolume"));
      currentVoice.once("end", handleEnd);
      currentVoice.once("loaderror", handleError);
      currentVoice.once("playerror", handleError);
      currentVoice.play();
    }
  }

  // 当想要播放VoiceJP的时候, 可以直接
  // eventBus.emit('playAudio', {voiceJPUrl: url})
  // 这样就可以了x

  eventBus.on("playAudio", (playAudioInfo: PlayAudio | undefined) => {
    if (
      !playAudioInfo ||
      Object.values(playAudioInfo).every(el => [undefined, null].includes(el))
    ) {
      console.warn("playAudioInfo is empty");
      return;
    }
    console.log(
      `Get playAudioInfo: ${
        playAudioInfo.soundUrl ||
        playAudioInfo.voiceJPUrl ||
        playAudioInfo.bgm?.url
      }`
    );
    playAudio(playAudioInfo);
  });

  eventBus.on("playEmotionAudio", (emotype: string) => {
    if (emotionSound) {
      emotionSound.stop();
    }
    emotionSound = getAudio(usePlayerStore().emotionSoundUrl(emotype));
    emotionSound.volume(channelVolume("sfxVolume"));
    emotionSound.play();
  });

  eventBus.on("playOtherSounds", sound => {
    console.log("Play Select Sound!");
    playAudio({ soundUrl: usePlayerStore().otherSoundUrl(sound) });
  });

  eventBus.on("playBgEffectSound", bgEffect => {
    playAudio({ soundUrl: usePlayerStore().bgEffectSoundUrl(bgEffect) });
  });
  eventBus.on("dispose", () => {
    soundUnload();
  });
  eventBus.on("stop", () => {
    soundDispose();
  });
  eventBus.on("continue", () => bgm?.play());
  eventBus.on(
    "playAudioWithConfig",
    ({
      url,
      config: {
        config: { volume },
      },
    }) => {
      const howl = getAudio(url);
      howl.volume(volume > 1 ? volume / 100 : volume);
      howl.play();
    }
  );
  eventBus.on("end", () => {
    soundUnload();
  });
}
