#!/usr/bin/env node
/**
 * 假 mpv —— 只实现**内核轨用得到的那部分 JSON IPC**，用来在没有真 mpv 的机器上
 * 证明「我们的客户端协议与 mpv 对得上」。
 *
 * 它模拟的是 mpv 的可观察行为，不是 mpv 本身：
 *   · 命令：loadfile / set_property / get_property / observe_property / sub-add / quit
 *   · 属性：pause / time-pos / duration / speed / track-list / demuxer-cache-state / eof-reached
 *   · 事件：file-loaded、property-change（observe 之后立刻补发一次当前值，与真 mpv 一致）
 *
 * 🔴 判据边界：本夹具证明的是**协议与状态机**，不证明「mkv 能解码、ass 能渲染」——
 *    后者只能由真 mpv + 真片源回答（R1 的机器依赖部分，台账如实登记）。
 *
 * 用法（由 `check:anime` 的 A8 拉起）：
 *   MIAO_MPV_BIN=node MIAO_MPV_SCRIPT=e2e/fixtures/_fake-mpv.mjs
 *   animesvc --kernel-selftest
 * 环境变量 `MIAO_FAKE_MPV_LOG` 指向一个文件时，收到的每条命令都会追加一行 JSON。
 */
import fs from 'node:fs';
import net from 'node:net';
import process from 'node:process';

const args = process.argv.slice(2);
const ipcArg = args.find((a) => a.startsWith('--input-ipc-server='));
if (!ipcArg) {
  console.error('fake-mpv: 缺 --input-ipc-server');
  process.exit(2);
}
const endpoint = ipcArg.slice('--input-ipc-server='.length);
const logFile = process.env.MIAO_FAKE_MPV_LOG || '';

const state = {
  duration: 1440.5,
  position: 0,
  paused: true,
  speed: 1,
  aid: 1,
  sid: 'no',
  eof: false,
  tracks: [
    { type: 'audio', id: 1, lang: 'jpn', title: '日语' },
    { type: 'audio', id: 2, lang: 'chi' },
    { type: 'sub', id: 3, lang: 'chi', title: '简中' },
  ],
};

/** 已 observe 的属性：name → propId（回事件时要带上） */
const observed = new Map();
let conn = null;

const log = (entry) => {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};

const send = (obj) => {
  if (conn && !conn.destroyed) conn.write(`${JSON.stringify(obj)}\n`);
};

const trackList = () =>
  state.tracks.map((t) => ({
    ...t,
    selected:
      t.type === 'audio'
        ? String(t.id) === String(state.aid)
        : state.sid !== 'no' && String(t.id) === String(state.sid),
  }));

function propValue(name) {
  switch (name) {
    case 'pause':
      return state.paused;
    case 'time-pos':
      return state.position;
    case 'duration':
      return state.duration;
    case 'speed':
      return state.speed;
    case 'track-list':
      return trackList();
    case 'demuxer-cache-state':
      return { 'cache-end': Math.min(state.duration, state.position + 5) };
    case 'eof-reached':
      return state.eof;
    default:
      return null;
  }
}

function emit(name) {
  if (!observed.has(name)) return;
  send({ event: 'property-change', id: observed.get(name), name, data: propValue(name) });
}

/** 处理一条命令，返回要合并进回执的字段。 */
function handle(cmd) {
  const op = cmd[0];
  if (op === 'loadfile') {
    state.position = 0;
    state.paused = true;
    state.eof = false;
    send({ event: 'file-loaded' });
    for (const n of ['duration', 'time-pos', 'pause', 'track-list']) emit(n);
    return {};
  }
  if (op === 'set_property') {
    const [, name, value] = cmd;
    if (name === 'pause') state.paused = value === true;
    else if (name === 'time-pos') state.position = Number(value) || 0;
    else if (name === 'speed') state.speed = Number(value) || 1;
    else if (name === 'aid') state.aid = value;
    else if (name === 'sid') state.sid = value;
    // 切轨要重发 track-list（selected 是算出来的，不是存下来的）
    if (name === 'aid' || name === 'sid') emit('track-list');
    else emit(name);
    return {};
  }
  if (op === 'get_property') {
    return { data: propValue(cmd[1]) };
  }
  if (op === 'observe_property') {
    observed.set(cmd[2], cmd[1]);
    // 真 mpv 在 observe 之后会立刻推一次当前值：没有这一下，客户端只能等到第一次变化
    queueMicrotask(() => emit(cmd[2]));
    return {};
  }
  if (op === 'sub-add') {
    const id = 10 + state.tracks.length;
    state.tracks.push({ type: 'sub', id, title: '外挂' });
    state.sid = id;
    emit('track-list');
    return {};
  }
  if (op === 'screenshot-to-file') {
    // 真 mpv 会写当前帧；夹具写一个字节，够证明命令真的到达并被受理
    try {
      fs.writeFileSync(cmd[1], Buffer.from([0x89]));
    } catch {
      /* 路径不可写时照旧回执：这里验的是协议，不是磁盘 */
    }
    return {};
  }
  if (op === 'quit') {
    setTimeout(() => process.exit(0), 10);
    return {};
  }
  return {};
}

const server = net.createServer((socket) => {
  conn = socket;
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    let at;
    while ((at = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, at).trim();
      buf = buf.slice(at + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 半截行 / 非 JSON：丢掉，不让它把连接带崩
      }
      log(msg);
      if (!Array.isArray(msg.command)) continue;
      const out = handle(msg.command);
      if (msg.request_id) send({ request_id: msg.request_id, error: 'success', ...out });
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    conn = null;
  });
});

// 播放推进：只有「不暂停」时才走时间轴（真 mpv 也是这个语义）
setInterval(() => {
  if (state.paused || state.eof) return;
  state.position = Math.min(state.duration, state.position + 0.1 * state.speed);
  if (state.position >= state.duration) {
    state.eof = true;
    state.paused = true;
    emit('eof-reached');
    emit('pause');
  }
  emit('time-pos');
}, 100).unref?.();

server.listen(endpoint);
server.on('error', (e) => {
  console.error(`fake-mpv: 监听 ${endpoint} 失败：${e.message}`);
  process.exit(3);
});

const bye = () => process.exit(0);
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
