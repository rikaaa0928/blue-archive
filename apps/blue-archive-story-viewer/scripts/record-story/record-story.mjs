import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

async function main() {
  const [,, rawStoryPath = 'groupStory/1101'] = process.argv;

  const parts = rawStoryPath.split('/');
  const queryType = parts[0].replace('Story', '');
  const id = parts[1];

  const recordUrlPath = `recordPlayer/${queryType}/${id}`;
  const url = `http://127.0.0.1:5173/${recordUrlPath}`;

  console.log('Launching browser for:', url);

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true, // 无头模式后台执行
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1920,1080',
      '--mute-audio',
      // 防止无头模式下后台页面动画或定时器被节流降帧
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ]
  });

  const videosDir = path.resolve('videos');
  if (!fs.existsSync(videosDir)) {
    fs.mkdirSync(videosDir);
  }

  const finalDest = path.join(videosDir, `${rawStoryPath.replace(/\//g, '_')}.webm`);
  const tempAudioDest = path.join(videosDir, `temp_audio_${Date.now()}.webm`);

  if (fs.existsSync(finalDest)) fs.unlinkSync(finalDest);
  if (fs.existsSync(tempAudioDest)) fs.unlinkSync(tempAudioDest);

  // Playwright 原生录制画面
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: {
      dir: videosDir,
      size: { width: 1920, height: 1080 }
    },
    bypassCSP: true,
  });

  // 通过 addInitScript 直接在页面加载前设置 localStorage，彻底杜绝需要先跳转一次所带来的多余白屏/主页截图
  await context.addInitScript(() => {
    localStorage.setItem('ba-story-viewer-settings', JSON.stringify({
      useMp3: false,
      initWithFullscreen: false
    }));
    
    // 播放器内部使用 "volume" 这个 key 单独存储音量
    localStorage.setItem('volume', JSON.stringify({
      masterVolume: 1,
      bgmVolume: 0.15, // 降低BGM音量，原默认是 0.3
      sfxVolume: 0.75,
      voiceVolume: 1
    }));
  });

  const videoStartTime = Date.now(); 

  const page = await context.newPage();

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

  console.log('Waiting for story player to be ready...');
  await page.waitForFunction(() => {
    const el = document.querySelector('.record-container');
    return el && !el.textContent?.includes('Loading');
  }, { timeout: 60000 });

  await page.waitForTimeout(1000);

  console.log('Clicking center to unlock AudioContext...');
  await page.mouse.click(960, 540);

  console.log('Injecting MediaRecorder (WebAudio ONLY) to capture pure audio stream...');

  const playStartTime = Date.now();

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

        window.mediaRecorder.ondataavailable = async (e) => {
          if (e.data && e.data.size > 0) {
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

  console.log(`AutoMode natively running. Now recording VIDEO via Playwright and AUDIO via MediaRecorder until the story completes...`);

  const fallbackTimeout = 30 * 60 * 1000; // 30 分钟兜底超时
  try {
    // 强制指定第三个参数为 options 避免 Playwright 解析重载错误，导致采用了默认的 30s
    await page.waitForFunction(() => window.__STORY_ENDED__ === true, undefined, { timeout: fallbackTimeout });
  } catch(e) {
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

  const trimSeconds = (playStartTime - videoStartTime) / 1000.0;

  console.log(`Muxing Audio and Video together using ffmpeg...`);
  console.log(`Cutting first ${trimSeconds.toFixed(2)} seconds of video to sync with audio.`);

  try {
    execSync(`ffmpeg -y -ss ${trimSeconds} -i "${videoTempPath}" -i "${tempAudioDest}" -c:v copy -c:a copy "${finalDest}"`, { stdio: 'ignore' });
    console.log(`\n✅ Final Video successfully saved to: ${finalDest}`);
  } catch(e) {
    console.error('Failed to mux video and audio. Make sure ffmpeg is installed.', e);
  }

  if (fs.existsSync(videoTempPath)) fs.unlinkSync(videoTempPath);
  if (fs.existsSync(tempAudioDest)) fs.unlinkSync(tempAudioDest);
}

main().catch(err => {
  console.error('Error during recording:', err);
  process.exit(1);
});
