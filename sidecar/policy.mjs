// 工具风险与会话模式。确认发生在应用界面，不看模型自己填的 confirm。
export const MODES = ['safe', 'autonomous', 'plan'];
export const LARGE_OVERWRITE = 8192;

const READ = new Set([
  'context_ref_read',
  'workspace_list', 'workspace_read', 'workspace_grep', 'workspace_job_output',
  'detect_crypto', 'diff_requests', 'find_signature_params',
  'grep_file', 'read_file_slice', 'list_project_files',
  'net_list', 'net_get', 'net_search', 'net_load_har', 'get_cookies',
  'anti_debug_status', 'inject_status', 'fingerprint_report', 'get_hook_records',
  'deobfuscate_code', 'ast_deobfuscate', 'vmp_trace_detect',
  'list_pages', 'select_page', 'select_frame', 'list_console_messages',
  'list_network_requests', 'list_scripts', 'get_script_source', 'search_in_sources',
  'list_breakpoints', 'get_request_initiator', 'get_paused_info', 'take_screenshot',
  'get_websocket_messages', 'todo_write',
]);

const WRITE = new Set([
  'workspace_write', 'workspace_edit',
  'notes_write', 'generate_report', 'export_code',
  'net_save_body', 'net_export_har', 'save_script_source',
  'env_from_fingerprint', 'capture_page_env', 'webpack_extract',
]);

const DESTRUCTIVE = new Set([
  'reset_session', 'restart_browser_fresh', 'clear_network_requests', 'clear_site_data',
]);

const CONFIRM_INJECT = new Set(['reset_session', 'restart_browser_fresh']);

export function toolRisk(name, args = {}) {
  if (name === 'todo_write' || name === 'workspace_job_output' || name === 'context_ref_read') return 'read';
  if (DESTRUCTIVE.has(name)) return 'destructive';
  if (name === 'workspace_shell' || name === 'workspace_job_kill' || name === 'workspace_run' || name === 'workspace_npm') return 'exec';
  if (WRITE.has(name)) return 'write';
  if (READ.has(name)) {
    if (args.outputFile && (name === 'deobfuscate_code' || name === 'ast_deobfuscate' || name === 'vmp_trace_detect' || name === 'fingerprint_report')) return 'write';
    if (name === 'take_screenshot' && args.filePath) return 'write';
    if (name === 'inject_status' && args.rearm) return 'exec';
    if (name === 'get_hook_records' && args.clear) return 'write';
    if (name === 'fingerprint_report' && args.save) return 'write';
    return 'read';
  }
  return 'exec';
}

export function planAllows(name, args = {}) {
  return toolRisk(name, args) === 'read';
}

export function isDifferentHost(target, current) {
  let a = '', b = '';
  try { a = new URL(String(target)).host.toLowerCase(); } catch { return false; }
  try { b = new URL(String(current)).host.toLowerCase(); } catch { return false; }
  if (!a || !b) return false;
  return a !== b;
}

// 仅安全模式会问。返回类别或 null。模型传入的 confirm 一律忽略。
export function approvalCategory(name, args = {}, extra = {}) {
  if (name === 'workspace_shell' || name === 'workspace_job_kill') return 'shell';
  if (name === 'workspace_npm' && args.command !== 'init') return 'npm';
  if (name === 'workspace_write' && (extra.existsBytes || 0) >= LARGE_OVERWRITE) return 'overwrite';
  if (name === 'reset_session' || name === 'restart_browser_fresh') return 'reset';
  if (name === 'navigate_page' && args.type && args.type !== 'url') return null;
  if ((name === 'navigate_page' || name === 'new_page') && args.url && isDifferentHost(args.url, extra.currentUrl)) return 'navigate';
  return null;
}

const LABELS = {
  shell: '运行 shell 命令',
  npm: '安装 npm 依赖',
  overwrite: '覆盖较大的已有文件',
  reset: '重置会话或重启干净浏览器',
  navigate: '导航到另一个网站',
};

export function approvalSummary(name, args = {}, category) {
  let detail = '';
  if (name === 'workspace_shell') detail = args.cmd || '';
  else if (name === 'workspace_npm') detail = [].concat(args.packages || args.package || args.command || 'install').join(' ');
  else if (name === 'workspace_write') detail = args.path || args.file || '';
  else if (name === 'workspace_job_kill') detail = args.id || '';
  else if (name === 'navigate_page' || name === 'new_page') detail = args.url || '';
  else if (name === 'reset_session') detail = args.scope || 'site';
  else if (name === 'restart_browser_fresh') detail = args.url || '';
  detail = String(detail).replace(/\s+/g, ' ').slice(0, 240);
  return `${LABELS[category] || '此操作'}需要确认\n\n${name}${detail ? ' · ' + detail : ''}\n\n允许后才会执行。选「本会话始终允许」则本会话内同类操作不再询问。`;
}

function allowsHas(allows, category) {
  if (!category || !allows) return false;
  if (typeof allows.has === 'function') return allows.has(category);
  return Array.isArray(allows) && allows.includes(category);
}

export function decideTool(mode, name, args = {}, extra = {}) {
  const m = MODES.includes(mode) ? mode : 'safe';
  if (m === 'plan' && !planAllows(name, args || {})) {
    return {
      action: 'deny',
      reason: `计划模式拒绝 ${name}：现在只能使用只读工具（请求、源码、搜索、工作区读取）。请用 todo_write 写好步骤并说明计划，等用户点击「执行」。`,
    };
  }
  const category = m === 'safe' ? approvalCategory(name, args || {}, extra) : null;
  const injectConfirm = CONFIRM_INJECT.has(name);
  if (category && !allowsHas(extra.allows, category)) {
    return { action: 'approve', category, summary: approvalSummary(name, args || {}, category), injectConfirm };
  }
  return { action: 'run', injectConfirm };
}
