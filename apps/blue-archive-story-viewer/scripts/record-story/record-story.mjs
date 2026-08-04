import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import { normalizeStoryPath } from '../../CICD/create-story/story-path.mjs';

function parseArguments(argv) {
  let rawStoryPath = 'groupStory/1101';
  let headless = true;
  let subtitleLanguage = 'cn';

  for (const argument of argv) {
    if (argument === '--headless' || argument === '--headless=true') {
      headless = true;
    } else if (
      argument === '--no-headless' ||
      argument === '--headed' ||
      argument === '--headless=false'
    ) {
      headless = false;
    } else if (argument.startsWith('--subtitle=')) {
      subtitleLanguage = argument.slice('--subtitle='.length);
      if (!['cn', 'en'].includes(subtitleLanguage)) {
        throw new Error(
          `Unsupported subtitle language: ${subtitleLanguage} (expected cn or en)`,
        );
      }
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      rawStoryPath = argument;
    }
  }

  return { rawStoryPath, headless, subtitleLanguage };
}

async function getRecordSelections(rawStoryPath) {
  const sharedConfigPath = path.resolve(
    '../../CICD/create-story/shared-config.mjs',
  );
  const configUrl = pathToFileURL(sharedConfigPath);
  configUrl.searchParams.set('cacheBust', String(Date.now()));
  const { storyPreSelections } = await import(configUrl.href);
  return storyPreSelections?.get(rawStoryPath) || [];
}

async function main() {
  const {
    rawStoryPath,
    headless,
    subtitleLanguage,
  } = parseArguments(process.argv.slice(2));

  const {
    storyPath,
    type: queryType,
    id,
  } = normalizeStoryPath(rawStoryPath);

  const recordUrlPath = `recordPlayer/${queryType}/${id}`;
  const recordSelections = await getRecordSelections(storyPath);
  const searchParams = new URLSearchParams({
    recordSelections: JSON.stringify(recordSelections),
    subtitleLanguage,
    captureHandshake: '1',
  });
  const url = `http://127.0.0.1:5173/${recordUrlPath}?${searchParams}`;

  console.log('Launching browser for:', `http://127.0.0.1:5173/${recordUrlPath}`);
  console.log('Recording pre-selections:', recordSelections);
  console.log('Recording subtitle language:', subtitleLanguage);

  const browser = await chromium.launch({
    channel: 'chrome',
    headless,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1920,1080',
      '--mute-audio',
      // 防止无头模式下后台页面动画或定时器被节流降帧
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });

  const videosDir = path.resolve('videos');
  if (!fs.existsSync(videosDir)) {
    fs.mkdirSync(videosDir);
  }

  // Interrupted recordings leave Playwright video files and streamed audio
  // chunks behind. Clear only those known temporary names before every
  // attempt so retries start clean without touching completed outputs.
  const staleRecordingCache = fs.readdirSync(videosDir).filter(fileName =>
    /^temp_audio_\d+\.webm$/.test(fileName) ||
    /^page@[0-9a-f]+\.webm$/i.test(fileName),
  );
  for (const fileName of staleRecordingCache) {
    fs.unlinkSync(path.join(videosDir, fileName));
  }
  if (staleRecordingCache.length > 0) {
    console.log(
      `Cleared ${staleRecordingCache.length} stale recording cache file(s).`,
    );
  }

  const subtitleSuffix = subtitleLanguage === 'cn' ? '' : `_${subtitleLanguage}`;
  const finalDest = path.join(
    videosDir,
    `${rawStoryPath.replace(/\//g, '_')}${subtitleSuffix}.webm`,
  );
  const syncMetadataDest = finalDest.replace(/\.webm$/, '.sync.json');
  const tempAudioDest = path.join(videosDir, `temp_audio_${Date.now()}.webm`);

  if (fs.existsSync(finalDest)) fs.unlinkSync(finalDest);
  if (fs.existsSync(syncMetadataDest)) fs.unlinkSync(syncMetadataDest);
  if (fs.existsSync(tempAudioDest)) fs.unlinkSync(tempAudioDest);

  // Playwright 原生录制画面
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: {
      dir: videosDir,
      size: { width: 1920, height: 1080 },
    },
    bypassCSP: true,
  });

  // 通过 addInitScript 直接在页面加载前设置 localStorage，彻底杜绝需要先跳转一次所带来的多余白屏/主页截图
  await context.addInitScript(() => {
    localStorage.setItem('ba-story-viewer-settings', JSON.stringify({
      useMp3: false,
      initWithFullscreen: false,
    }));

    // 播放器内部使用 "volume" 这个 key 单独存储音量
    localStorage.setItem('volume', JSON.stringify({
      masterVolume: 1,
      bgmVolume: 0.25,
      sfxVolume: 0.9,
      voiceVolume: 1,
    }));
  });

  const videoStartTime = Date.now();

  const page = await context.newPage();
  const isPopupFallbackAttempt = (message, location = '') => {
    if (message.startsWith('[popup fallback] both candidates failed:')) {
      return false;
    }
    return /\/04_ScenarioImage\/popup[^/?]*\.png/i.test(
      `${message} ${location}`,
    );
  };
  page.on('console', message => {
    const type = message.type();
    const text = message.text();
    const location = message.location().url || '';
    if (type === 'error') {
      if (isPopupFallbackAttempt(text, location)) {
        console.warn(
          `[browser console:warning] [popup fallback attempt] ${text}`,
        );
      } else {
        console.error(`[browser console] ${text}`);
      }
    } else if (text.startsWith('[popup fallback]')) {
      console.log(`[browser console:${type}] ${text}`);
    }
  });
  page.on('pageerror', error => {
    const detail = error.stack || error.message;
    if (isPopupFallbackAttempt(detail)) {
      console.warn(
        `[browser pageerror:warning] [popup fallback attempt] ${detail}`,
      );
    } else {
      console.error(`[browser pageerror] ${detail}`);
    }
  });
  page.on('requestfailed', request => {
    const failure = request.failure();
    const detail = `${request.url()}: ${failure?.errorText || 'unknown error'}`;
    if (isPopupFallbackAttempt(detail, request.url())) {
      console.warn(
        `[browser request failed:warning] [popup fallback attempt] ${detail}`,
      );
    } else {
      console.error(`[browser request failed] ${detail}`);
    }
  });

  // 把页面的纯音频分片桥接回来
  await page.exposeFunction('saveAudioChunk', (base64Str) => {
    try {
      const buffer = Buffer.from(base64Str, 'base64');
      fs.appendFileSync(tempAudioDest, buffer);
    } catch(err) {
      console.error('Error writing audio chunk:', err);
    }
  });

  console.log(`Navigating to specialized record page: ${url}...`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  console.log('Waiting for story data and the automatic capture handshake...');
  await page.waitForFunction(
    () =>
      typeof window.__START_STORY_RECORDING__ === 'function' &&
      window.__STORY_PLAYER_READY__ === true,
    undefined,
    { timeout: 60000 },
  );
  if (!(await page.locator('.loading-container').isVisible())) {
    throw new Error(
      'Player loading layer disappeared before the recorder was ready',
    );
  }

  console.log('Injecting MediaRecorder before playback starts...');

  const audioRecorderStartBefore = Date.now();
  await page.evaluate(() => {
    return new Promise((resolve, reject) => {
      try {
        let targetHowler = window.Howler;

        if (!targetHowler.ctx) {
          if (typeof targetHowler.volume === "function") {
            targetHowler.volume(targetHowler.volume());
          }
        }

        const audioCtx = targetHowler.ctx;
        if (!audioCtx) {
          throw new Error("No AudioContext found!");
        }

        if (audioCtx.state === 'suspended') {
          audioCtx.resume();
        }

        const dest = audioCtx.createMediaStreamDestination();
        if (targetHowler.masterGain) {
          targetHowler.masterGain.connect(dest);
        } else {
          throw new Error("No masterGain found!");
        }

        window.mediaRecorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm; codecs=opus' });
        window.__RECORDING_AUDIO_CHUNK_COUNT__ = 0;
        window.__RECORDING_AUDIO_BYTE_COUNT__ = 0;

        window.mediaRecorder.ondataavailable = async (e) => {
          if (e.data && e.data.size > 0) {
            window.__RECORDING_AUDIO_CHUNK_COUNT__ += 1;
            window.__RECORDING_AUDIO_BYTE_COUNT__ += e.data.size;
            const arrayBuffer = await e.data.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            let binary = '';
            for (let i = 0; i < uint8Array.byteLength; i++) {
              binary += String.fromCharCode(uint8Array[i]);
            }
            const b64 = btoa(binary);
            window.saveAudioChunk(b64);
          }
        };

        window.mediaRecorder.start(500);
        resolve();
      } catch (err) {
        reject(err.message);
      }
    });
  });
  const audioRecorderStartTime =
    (audioRecorderStartBefore + Date.now()) / 2;

  await page.evaluate(() => {
    const container = document.querySelector('.record-container');
    if (!container) {
      throw new Error('Recording container is missing');
    }
    container.addEventListener('click', async () => {
      try {
        await window.Howler.ctx.resume();
        window.__RECORDING_AUDIO_UNLOCKED__ =
          window.Howler.ctx.state === 'running';
      } catch (error) {
        window.__STORY_ERROR__ =
          `Failed to unlock recording AudioContext: ${error?.message || error}`;
      }
    }, { once: true });
  });

  console.log('Unlocking AudioContext with an automatic center click...');
  await page.click('.record-container', { position: { x: 960, y: 540 } });
  await page.waitForFunction(
    () => window.__RECORDING_AUDIO_UNLOCKED__ === true,
    undefined,
    { timeout: 10000 },
  );

  const playStartTime = Date.now();
  console.log('Capture ready. Starting the recording page automatically...');
  await page.evaluate(() => window.__START_STORY_RECORDING__());
  await page.waitForFunction(
    () => window.__STORY_RECORDING_STARTED__ === true,
    undefined,
    { timeout: 10000 },
  );
  await page.waitForFunction(
    () => !document.querySelector('.loading-container'),
    undefined,
    { timeout: 10000 },
  );
  await page.waitForFunction(
    () =>
      window.__RECORDING_AUDIO_CHUNK_COUNT__ >= 3 &&
      window.__RECORDING_AUDIO_BYTE_COUNT__ > 2048,
    undefined,
    { timeout: 15000 },
  );
  const audioCaptureStats = await page.evaluate(() => ({
    chunks: window.__RECORDING_AUDIO_CHUNK_COUNT__,
    bytes: window.__RECORDING_AUDIO_BYTE_COUNT__,
  }));
  console.log(
    `Audio capture confirmed: ${audioCaptureStats.chunks} chunks, ` +
      `${audioCaptureStats.bytes} bytes.`,
  );

  console.log(
    'AutoMode natively running. Now recording VIDEO via Playwright and ' +
      'AUDIO via MediaRecorder until the story completes...',
  );

  const fallbackTimeout = 30 * 60 * 1000; // 30 分钟兜底超时
  try {
    // 强制指定第三个参数为 options 避免 Playwright 解析重载错误，导致采用了默认的 30s
    await page.waitForFunction(
      () => window.__STORY_ENDED__ === true || Boolean(window.__STORY_ERROR__),
      undefined,
      { timeout: fallbackTimeout },
    );
    const storyError = await page.evaluate(() => window.__STORY_ERROR__);
    if (storyError) {
      throw new Error(`Story player failed: ${storyError}`);
    }
  } catch(e) {
    if (e?.name !== 'TimeoutError') {
      throw e;
    }
    console.log(`Reached fallback timeout of ${fallbackTimeout / 1000} seconds. Stopping the recording forcefully...`);
  }

  console.log('Story play ended natively. Wrapping up audio streams...');
  await page.evaluate(() => {
    return new Promise((resolve) => {
      if (window.mediaRecorder && window.mediaRecorder.state !== 'inactive') {
        window.mediaRecorder.onstop = () => setTimeout(resolve, 500);
        window.mediaRecorder.stop();
      } else {
        resolve();
      }
    });
  });

  await page.waitForTimeout(1000);

  const videoTempPath = await page.video().path();
  await context.close();
  await browser.close();

  const trimSeconds = (audioRecorderStartTime - videoStartTime) / 1000.0;
  const audioLeadSeconds =
    (playStartTime - audioRecorderStartTime) / 1000.0;
  const finalPrerollSeconds = 0.5;
  const recommendedFinalTrimSeconds = Math.max(
    0,
    trimSeconds + audioLeadSeconds - finalPrerollSeconds,
  );

  console.log(`Muxing Audio and Video together using ffmpeg...`);
  console.log(
    `Placing audio at ${trimSeconds.toFixed(3)} seconds on the video ` +
      `timeline (playback began ` +
      `${audioLeadSeconds.toFixed(3)} seconds later).`,
  );

  try {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-i',
        videoTempPath,
        '-itsoffset',
        String(trimSeconds),
        '-i',
        tempAudioDest,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'copy',
        '-c:a',
        'copy',
        finalDest,
      ],
      { stdio: 'ignore' },
    );
    fs.writeFileSync(
      syncMetadataDest,
      `${JSON.stringify({
        videoStartToAudioStartSeconds: trimSeconds,
        audioStartToPlaybackSeconds: audioLeadSeconds,
        finalPrerollSeconds,
        recommendedFinalTrimSeconds,
      }, null, 2)}\n`,
    );
    console.log(`\n✅ Final Video successfully saved to: ${finalDest}`);
  } catch(e) {
    throw new Error(
      `Failed to mux video and audio: ${e?.message || e}`,
    );
  }

  if (fs.existsSync(videoTempPath)) fs.unlinkSync(videoTempPath);
  if (fs.existsSync(tempAudioDest)) fs.unlinkSync(tempAudioDest);
}

main().catch(err => {
  console.error('Error during recording:', err);
  process.exit(1);
});
