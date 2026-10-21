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

function trackDownload(ev, state) {
  if (ev.event === 'Started') state.contentLength = ev.data.contentLength || 0;
  else if (ev.event === 'Progress') state.downloaded += ev.data.chunkLength || 0;
  else if (ev.event === 'Finished' && state.contentLength) state.downloaded = state.contentLength;
  return { event: ev.event, downloaded: state.downloaded, contentLength: state.contentLength };
}

/** 下载并安装。progressCb 在下载过程中收到百分比，进入安装阶段时 event 为 Installing。 */
export async function downloadAndInstall(update, progressCb) {
  const state = { downloaded: 0, contentLength: 0 };
  await update.download((ev) => progressCb?.(trackDownload(ev, state)));
  progressCb?.({ event: 'Installing', downloaded: state.downloaded, contentLength: state.contentLength });
  // 让「正在安装」先画出来，再去做可能要几秒的进程清理。
  await new Promise((r) => setTimeout(r, 60));
  if (native.isNative()) await native.prepareForUpdate();
  await update.install();
}

export async function installAndRelaunch(update, progressCb) {
  await downloadAndInstall(update, progressCb);
  // Windows 上 install() 会拉起安装器并退出进程；安装器带 /R，装完自己重新打开。
  // 其它平台安装不会退出，这里再重启。
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
