// 在线更新（tauri-plugin-updater）— 启动静默检查 + 设置页手动检查
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { native } from './transport.js';

export async function checkForUpdate() {
  if (!native.isNative()) return { available: false, reason: 'web-dev' };
  try {
    const update = await check();
    if (!update) return { available: false };
    return {
      available: true,
      version: update.version,
      notes: update.body || '',
      date: update.date || '',
      raw: update,
    };
  } catch (e) {
    return { available: false, error: String(e?.message || e) };
  }
}

/** 下载并安装，progressCb({event, data}) */
export async function downloadAndInstall(update, progressCb) {
  let downloaded = 0, contentLength = 0;
  await update.downloadAndInstall((ev) => {
    if (ev.event === 'Started') contentLength = ev.data.contentLength || 0;
    else if (ev.event === 'Progress') downloaded += ev.data.chunkLength || 0;
    progressCb?.({ event: ev.event, downloaded, contentLength, data: ev.data });
  });
}

export async function installAndRelaunch(update, progressCb) {
  await downloadAndInstall(update, progressCb);
  await relaunch();
}

/** 启动后延迟静默检查（不弹窗打扰；有更新时回调） */
export function scheduleStartupCheck(onAvailable, delayMs = 4000) {
  if (!native.isNative()) return () => {};
  const t = setTimeout(async () => {
    const r = await checkForUpdate();
    if (r.available) onAvailable?.(r);
  }, delayMs);
  return () => clearTimeout(t);
}
