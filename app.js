/* QuickCut — standalone browser video editor. No backend or external dependencies. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const state = {
    clips: [], audio: [], selected: null, time: 0, playing: false,
    zoom: 65, history: [], future: [], exporting: false, importBusy: false,
  };
  const sources = new Map();
  const LIMITS = { minClip: 0.08, maxHistory: 60, maxFade: 20 };
  let audioContext = null, audioDestination = null, audioMaster = null;
  let activeVideoId = null, activeAudioIds = new Set(), frameBusy = false;
  let playAnchor = 0, lastRenderToken = 0, drag = null, exportAbort = false;
  let toastTimeout;
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = v => { const n = Math.max(0, Number(v) || 0); return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.floor(n % 60)).padStart(2, '0')}.${Math.floor((n % 1) * 10)}`; };
  const clipDuration = c => Math.max(0, (c.out - c.inPoint) / c.speed);
  const timelineDuration = () => state.clips.reduce((sum, c) => sum + clipDuration(c), 0);
  function locate(time) {
    let start = 0;
    for (const clip of state.clips) {
      const duration = clipDuration(clip);
      if (time >= start - 1e-6 && time < start + duration - 1e-6) return { clip, start, local: clamp(time - start, 0, duration) };
      start += duration;
    }
    return null;
  }
  function toast(message, error = false) {
    const node = $('toast'); node.textContent = message;
    node.classList.toggle('error', error); node.style.display = 'block';
    clearTimeout(toastTimeout); toastTimeout = setTimeout(() => node.style.display = 'none', 4200);
  }
  function snapshot() { return JSON.stringify({ clips: state.clips, audio: state.audio, selected: state.selected, time: state.time }); }
  function checkpoint() { if (state.exporting) return; state.history.push(snapshot()); if (state.history.length > LIMITS.maxHistory) state.history.shift(); state.future.length = 0; }
  function restore(saved) {
    pause(); const v = JSON.parse(saved); state.clips = v.clips; state.audio = v.audio;
    state.selected = v.selected; state.time = clamp(v.time, 0, timelineDuration());
    activeVideoId = null; activeAudioIds.clear(); refresh();
  }
  function undo() { if (!state.history.length || state.exporting) return; state.future.push(snapshot()); restore(state.history.pop()); }
  function redo() { if (!state.future.length || state.exporting) return; state.history.push(snapshot()); restore(state.future.pop()); }
  function mutate(callback) {
    if (state.exporting) return; pause(); checkpoint(); callback();
    state.time = clamp(state.time, 0, timelineDuration()); activeVideoId = null; refresh();
  }
  function clearProject() {
    if (state.exporting) return;
    if ((state.clips.length || state.audio.length) && !window.confirm('Tạo dự án mới? Timeline hiện tại sẽ bị xóa (tệp gốc trên máy không bị thay đổi).')) return;
    pause(); state.clips = []; state.audio = []; state.selected = null; state.time = 0;
    state.history = []; state.future = []; activeVideoId = null; activeAudioIds.clear();
    for (const asset of sources.values()) { if (asset.type !== 'image') asset.element.pause(); URL.revokeObjectURL(asset.url); }
    sources.clear(); refresh(); toast('Đã tạo dự án mới.');
  }
  function makeClip(asset) {
    return { id: uid(), mediaId: asset.id, name: asset.file.name,
      type: asset.type, inPoint: 0, out: asset.duration, speed: 1, volume: 1,
      fadeIn: 0, fadeOut: 0, brightness: 0, contrast: 0, saturation: 0,
      exposure: 0, temperature: 0, blur: 0, motion: 'none', fit: 'contain',
      position: 0 };
  }
  async function loadAsset(file, requestedType) {
    const type = requestedType || (file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : null);
    if (!type) throw new Error(`Loại tệp không được hỗ trợ: ${file.name}`);
    const id = uid(), url = URL.createObjectURL(file);
    const element = document.createElement(type === 'image' ? 'img' : type);
    element.preload = 'auto'; element.playsInline = true;
    if (type !== 'image') element.muted = true;
    const result = await new Promise((resolve, reject) => {
      let complete = false;
      const cleanup = () => { clearTimeout(timer); element.removeEventListener('load', success); element.removeEventListener('loadedmetadata', success); element.removeEventListener('error', failure); };
      const success = () => { if (complete) return; complete = true; cleanup(); resolve(element); };
      const failure = () => { if (complete) return; complete = true; cleanup(); reject(new Error(`Không mở được tệp: ${file.name}. Hãy thử MP4 (H.264), WebM, JPG/PNG hoặc MP3.`)); };
      const timer = setTimeout(failure, 20000);
      element.addEventListener(type === 'image' ? 'load' : 'loadedmetadata', success);
      element.addEventListener('error', failure);
      element.src = url;
      if (type !== 'image') element.load();
    }).catch(e => { URL.revokeObjectURL(url); throw e; });
    const duration = type === 'image' ? 5 : result.duration;
    if (type !== 'image' && (!Number.isFinite(duration) || duration <= 0)) {
      URL.revokeObjectURL(url); throw new Error(`Tệp không có thời lượng hợp lệ: ${file.name}`);
    }
    const asset = { id, file, url, element, type, duration, audioGain: null, audioNode: null };
    sources.set(id, asset);
    if (audioContext) connectAudio(asset);
    return asset;
  }
  async function importFiles(files, requestedType) {
    if (state.exporting || !files || !files.length || state.importBusy) return;
    state.importBusy = true;
    const added = [], errors = [];
    for (const file of Array.from(files)) {
      try {
        const asset = await loadAsset(file, requestedType);
        if (asset.type === 'audio') {
          const item = makeClip(asset); item.position = 0; added.push({ audio: item });
        } else added.push({ clip: makeClip(asset) });
      } catch (e) { errors.push(e.message); }
    }
    if (added.length) {
      mutate(() => { for (const item of added) { if (item.clip) { state.clips.push(item.clip); state.selected = item.clip.id; } else { state.audio.push(item.audio); state.selected = item.audio.id; } } });
      toast(`Đã thêm ${added.length} tệp${errors.length ? ` · ${errors.length} tệp lỗi` : ''}`);
    }
    if (errors.length) toast(errors.join(' | '), true);
    state.importBusy = false; refresh();
  }
  function selectedClip() { return state.clips.find(c => c.id === state.selected) || state.audio.find(c => c.id === state.selected) || null; }
  function fadeValue(c, local) {
    const d = clipDuration(c);
    const left = c.fadeIn ? clamp(local / c.fadeIn, 0, 1) : 1;
    const right = c.fadeOut ? clamp((d - local) / c.fadeOut, 0, 1) : 1;
    return Math.min(left, right);
  }
  function cssFilter(c) {
    return `brightness(${Math.max(0, 100 + c.brightness + c.exposure * .65)}%) contrast(${Math.max(0, 100 + c.contrast)}%) saturate(${Math.max(0, 100 + c.saturation)}%) blur(${c.blur || 0}px)`;
  }
  function drawMedia(c, element, local) {
    const width = element.videoWidth || element.naturalWidth, height = element.videoHeight || element.naturalHeight;
    if (!width || !height) return;
    ctx.save();
    ctx.globalAlpha = fadeValue(c, local);
    ctx.filter = cssFilter(c);
    const ratio = c.fit === 'cover' ? Math.max(canvas.width / width, canvas.height / height) : Math.min(canvas.width / width, canvas.height / height);
    const progress = clipDuration(c) ? clamp(local / clipDuration(c), 0, 1) : 0;
    let scale = 1, x = 0;
    if (c.type === 'image') {
      if (c.motion === 'zoom-in') scale = 1 + .11 * progress;
      if (c.motion === 'zoom-out') scale = 1.11 - .11 * progress;
      if (c.motion === 'pan-left') { scale = 1.12; x = canvas.width * .055 * (1 - 2 * progress); }
      if (c.motion === 'pan-right') { scale = 1.12; x = canvas.width * .055 * (2 * progress - 1); }
    }
    const targetW = width * ratio * scale, targetH = height * ratio * scale;
    try { ctx.drawImage(element, (canvas.width - targetW) / 2 + x, (canvas.height - targetH) / 2, targetW, targetH); }
    catch (e) { console.warn('Không vẽ được khung hình', e); }
    if (c.temperature) {
      ctx.filter = 'none'; ctx.globalCompositeOperation = 'soft-light';
      const alpha = Math.abs(c.temperature) / 250;
      ctx.fillStyle = c.temperature > 0 ? `rgba(255,145,45,${alpha})` : `rgba(52,142,255,${alpha})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.restore();
  }
  function drawFrame(time) {
    ctx.fillStyle = '#050505'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const item = locate(Math.min(time, Math.max(0, timelineDuration() - .00001)));
    if (!item) return;
    const asset = sources.get(item.clip.mediaId);
    if (!asset) return;
    if (asset.type === 'image' || asset.element.readyState >= 2) drawMedia(item.clip, asset.element, item.local);
  }
  function seekElement(element, value, tolerance = .05) {
    if (Math.abs(element.currentTime - value) <= tolerance && element.readyState >= 2) return Promise.resolve(true);
    return new Promise(resolve => {
      let finished = false;
      const end = ok => { if (finished) return; finished = true; clearTimeout(timer); element.removeEventListener('seeked', onSeeked); element.removeEventListener('error', onError); resolve(ok); };
      const onSeeked = () => end(true), onError = () => end(false);
      const timer = setTimeout(() => end(false), 2500);
      element.addEventListener('seeked', onSeeked, { once: true });
      element.addEventListener('error', onError, { once: true });
      try { element.currentTime = clamp(value, 0, Math.max(0, (element.duration || value + .1) - .002)); } catch (_) { end(false); }
    });
  }
  function pauseVideoAssets(exceptMediaId = null) {
    for (const s of sources.values()) if (s.type === 'video' && s.id !== exceptMediaId) s.element.pause();
  }
  async function prepareVideo(item, desiredTime, playback) {
    const asset = sources.get(item.clip.mediaId);
    if (!asset || asset.type !== 'video') return;
    const el = asset.element, target = clamp(item.clip.inPoint + item.local * item.clip.speed, 0, asset.duration - .005);
    const isNewClip = activeVideoId !== item.clip.id;
    if (isNewClip) {
      pauseVideoAssets(asset.id);
      el.pause();
      activeVideoId = item.clip.id;
      const ok = await seekElement(el, target);
      if (!ok) throw new Error(`Không thể giải mã/đọc đoạn video ${item.clip.name}`);
    } else if (!playback && Math.abs(el.currentTime - target) > .04) {
      const ok = await seekElement(el, target);
      if (!ok) throw new Error(`Không thể tua video ${item.clip.name}`);
    } else if (playback && Math.abs(el.currentTime - target) > .7) {
      await seekElement(el, target);
    }
    el.playbackRate = item.clip.speed;
    if (playback) {
      if (el.paused) await el.play().catch(() => {});
    } else el.pause();
  }
  async function renderAt(time, isPlayback = false, force = false) {
    const token = ++lastRenderToken;
    if (frameBusy && !force) { drawFrame(time); return; }
    frameBusy = true;
    try {
      const item = locate(Math.min(time, Math.max(0, timelineDuration() - 0.00001)));
      if (item?.clip.type === 'video') await prepareVideo(item, time, isPlayback);
      else { if (activeVideoId) pauseVideoAssets(); activeVideoId = null; }
      if (isPlayback || token === lastRenderToken) drawFrame(time);
    } catch (error) { if (!isPlayback) console.warn(error); }
    finally { frameBusy = false; }
  }
  function initAudio() {
    if (audioContext) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('Trình duyệt không hỗ trợ xử lý âm thanh.');
    audioContext = new AudioContextClass();
    audioDestination = audioContext.createMediaStreamDestination();
    audioMaster = audioContext.createGain();
    audioMaster.connect(audioContext.destination);
    audioMaster.connect(audioDestination);
    for (const s of sources.values()) connectAudio(s);
  }
  function connectAudio(asset) {
    if (!audioContext || asset.type === 'image' || asset.audioNode) return;
    try {
      asset.audioNode = audioContext.createMediaElementSource(asset.element);
      asset.audioGain = audioContext.createGain(); asset.audioGain.gain.value = 0;
      asset.audioNode.connect(asset.audioGain); asset.audioGain.connect(audioMaster);
      asset.element.muted = false; // Gain nodes, not <video muted>, control monitor AND exported audio.
    } catch (e) { console.warn('Không nối được âm thanh', e); }
  }
  function updateAudio(time, isPlayback) {
    if (!audioContext) return;
    const activeItem = locate(Math.min(time, Math.max(0, timelineDuration() - .00001)));
    const gains = new Map();
    if (activeItem?.clip.type === 'video') gains.set(activeItem.clip.mediaId, activeItem.clip.volume * fadeValue(activeItem.clip, activeItem.local));
    const now = audioContext.currentTime;
    for (const c of state.audio) {
      const asset = sources.get(c.mediaId); if (!asset) continue;
      connectAudio(asset);
      const local = time - c.position, length = clipDuration(c);
      if (local >= 0 && local < length && isPlayback) {
        const target = clamp(c.inPoint + local * c.speed, 0, asset.duration - .005);
        if (!activeAudioIds.has(c.id) || Math.abs(asset.element.currentTime - target) > .6) asset.element.currentTime = target;
        asset.element.playbackRate = c.speed;
        if (asset.element.paused) asset.element.play().catch(() => {});
        gains.set(c.mediaId, (gains.get(c.mediaId) || 0) + c.volume * fadeValue(c, local));
        activeAudioIds.add(c.id);
      } else {
        asset.element.pause(); activeAudioIds.delete(c.id);
      }
    }
    for (const asset of sources.values()) if (asset.audioGain) {
      const target = gains.get(asset.id) || 0;
      asset.audioGain.gain.setTargetAtTime(target, now, .007);
    }
  }
  function pause() {
    state.playing = false;
    for (const s of sources.values()) if (s.type !== 'image') s.element.pause();
    $('play').textContent = '▶';
  }
  async function play() {
    if (!state.clips.length || state.exporting) return;
    if (state.time >= timelineDuration() - .005) state.time = 0;
    try { initAudio(); await audioContext.resume(); } catch (e) { toast(e.message, true); return; }
    state.playing = true; playAnchor = performance.now() - state.time * 1000;
    $('play').textContent = 'Ⅱ';
    const item = locate(state.time);
    if (item?.clip.type === 'video') await prepareVideo(item, state.time, true).catch(e => toast(e.message, true));
    updateAudio(state.time, true);
    playAnchor = performance.now() - state.time * 1000;
  }
  function togglePlayback() { state.playing ? pause() : play(); }
  function seekTimeline(t) {
    if (state.exporting) return;
    pause(); state.time = clamp(t, 0, timelineDuration());
    activeVideoId = null; activeAudioIds.clear(); updateTimeUI(); renderAt(state.time, false, true);
  }
  function updateTimeUI() {
    $('time').textContent = `${fmt(state.time)} / ${fmt(timelineDuration())}`;
    const head = $('playhead'); head.style.left = `${122 + state.time * state.zoom}px`;
  }
  function animation(now) {
    if (state.playing && !state.exporting) {
      const end = timelineDuration(); state.time = clamp((now - playAnchor) / 1000, 0, end);
      if (state.time >= end) { pause(); state.time = end; }
      else { renderAt(state.time, true); updateAudio(state.time, true); }
      updateTimeUI();
    }
    requestAnimationFrame(animation);
  }
  requestAnimationFrame(animation);
  function updateTimeline() {
    const px = state.zoom, w = Math.max(650, Math.ceil(timelineDuration() * px) + 110);
    $('ruler').style.width = `${w}px`;
    $('ruler').replaceChildren();
    const interval = px < 42 ? 5 : px < 85 ? 2 : 1;
    for (let t = 0; t <= timelineDuration() + interval; t += interval) {
      const marker = document.createElement('span'); marker.textContent = fmt(t); marker.style.left = `${t * px}px`; $('ruler').append(marker);
    }
    const main = $('videoTrack'); main.style.width = `${w}px`; main.replaceChildren();
    let start = 0;
    for (const c of state.clips) {
      const element = clipElement(c, start, false); main.append(element); start += clipDuration(c);
    }
    const audio = $('audioTrack'); audio.style.width = `${w}px`; audio.replaceChildren();
    for (const c of state.audio) audio.append(clipElement(c, c.position, true));
    updateTimeUI();
  }
  function clipElement(c, start, isAudio) {
    const div = document.createElement('div');
    div.className = `clip${c.type === 'image' ? ' image' : ''}${isAudio ? ' audio' : ''}${state.selected === c.id ? ' selected' : ''}`;
    div.dataset.id = c.id;
    div.style.left = `${start * state.zoom}px`;
    div.style.width = `${Math.max(6, clipDuration(c) * state.zoom)}px`;
    div.title = `${c.name} · ${fmt(clipDuration(c))} · ${c.speed}×`;
    const handleL = document.createElement('span'); handleL.className = 'clip-handle left';
    const label = document.createElement('span'); label.className = 'clip-label'; label.textContent = c.name;
    const handleR = document.createElement('span'); handleR.className = 'clip-handle right';
    div.append(handleL, label, handleR);
    if (c.fadeIn > 0) { const f = document.createElement('span'); f.className = 'fade-left'; div.append(f); }
    if (c.fadeOut > 0) { const f = document.createElement('span'); f.className = 'fade-right'; div.append(f); }
    div.addEventListener('pointerdown', onClipDown);
    return div;
  }
  function onClipDown(event) {
    if (state.exporting) return;
    const id = event.currentTarget.dataset.id;
    const clip = [...state.clips, ...state.audio].find(c => c.id === id);
    if (!clip) return;
    pause(); state.selected = id;
    const handle = event.target.closest('.clip-handle');
    drag = { id, mode: handle?.classList.contains('left') ? 'trim-left' : handle?.classList.contains('right') ? 'trim-right' : 'move', x: event.clientX,
      initial: { ...clip }, index: state.clips.findIndex(c => c.id === id), started: false };
    updateInspector(); updateTimeline();
    window.addEventListener('pointermove', onClipMove);
    window.addEventListener('pointerup', onClipUp, { once: true });
    event.preventDefault();
  }
  function onClipMove(event) {
    if (!drag) return;
    const dx = (event.clientX - drag.x) / state.zoom;
    if (Math.abs(dx) < .045 && !drag.started) return;
    const c = [...state.clips, ...state.audio].find(v => v.id === drag.id);
    if (!c) return;
    if (!drag.started) { checkpoint(); drag.started = true; }
    const old = drag.initial, min = LIMITS.minClip;
    if (drag.mode === 'trim-left') {
      const next = clamp(old.inPoint + dx * old.speed, 0, old.out - min);
      c.inPoint = next;
      if (c.type === 'audio') c.position = Math.max(0, old.position + (next - old.inPoint) / old.speed);
    } else if (drag.mode === 'trim-right') {
      c.out = clamp(old.out + dx * old.speed, c.inPoint + min, sources.get(c.mediaId)?.duration || old.out);
    } else if (c.type === 'audio') c.position = Math.max(0, old.position + dx);
    else {
      const index = state.clips.findIndex(v => v.id === c.id);
      const center = (event.clientX - $('videoTrack').getBoundingClientRect().left) / state.zoom;
      let sum = 0, destination = state.clips.length - 1;
      for (let i = 0; i < state.clips.length; i++) {
        sum += clipDuration(state.clips[i]);
        if (center < sum) { destination = i; break; }
      }
      if (index !== destination) { state.clips.splice(index, 1); state.clips.splice(destination, 0, c); }
    }
    c.fadeIn = clamp(c.fadeIn, 0, clipDuration(c));
    c.fadeOut = clamp(c.fadeOut, 0, clipDuration(c));
    state.time = clamp(state.time, 0, timelineDuration());
    updateTimeline(); updateInspector();
  }
  function onClipUp() {
    window.removeEventListener('pointermove', onClipMove);
    if (drag?.started) { activeVideoId = null; renderAt(state.time, false, true); }
    drag = null; refresh();
  }
  function field(name, key, min, max, step = 1, formatter = v => String(v), c = selectedClip()) {
    const value = c[key];
    return `<div class="field"><label><span>${name}</span><output data-output="${key}">${formatter(value)}</output></label><input type="range" data-field="${key}" min="${min}" max="${Math.max(min, max)}" step="${step}" value="${value}"></div>`;
  }
  const plain = v => String(v);
  const percent = v => `${Math.round(v * 100)}%`;
  const secs = v => `${Number(v).toFixed(1)} s`;
  function updateInspector() {
    const c = selectedClip(), panel = $('controls');
    $('selectedName').textContent = c ? c.name : 'Chưa chọn clip';
    if (!c) { panel.innerHTML = '<div class="placeholder">Chọn đoạn video, ảnh hoặc nhạc trên timeline để điều chỉnh.</div>'; return; }
    const duration = clipDuration(c);
    let html = `<div class="group"><h4>ĐOẠN ĐÃ CHỌN</h4><div class="field note">Thời lượng: <strong>${fmt(duration)}</strong> · ${c.type === 'image' ? 'Hình ảnh' : c.type === 'audio' ? 'Âm thanh' : 'Video'}</div>`;
    if (c.type !== 'image') html += field('Tốc độ', 'speed', .25, 4, .05, v => `${Number(v).toFixed(2)}×`, c);
    if (c.type !== 'image') html += `<div class="chip-row"><button class="btn mini" id="toggleMute">${c.volume === 0 ? '🔊 Bật tiếng' : '🔇 Tắt tiếng'}</button>${c.type === 'video' ? '<span class="hint">Tắt riêng âm thanh clip này</span>' : ''}</div>` + field('Âm lượng', 'volume', 0, 2, .05, percent, c);
    if (c.type !== 'image') html += `<div class="chip-row speeds"><span class="hint">Nhanh:</span>${[.5,1,1.5,2].map(rate => `<button class="btn mini${c.speed===rate?' selected-chip':''}" data-rate="${rate}">${rate}×</button>`).join('')}</div>`;
    if (c.type === 'image') html += field('Thời lượng ảnh', 'out', .25, 60, .25, secs, c);
    if (c.type === 'audio') html += field('Vị trí nhạc', 'position', 0, Math.max(timelineDuration(), 120), .1, secs, c);
    if (c.type === 'video' || c.type === 'audio') {
      html += `<div class="field two"><label>Bắt đầu (s)<input type="number" min="0" max="${(c.out - LIMITS.minClip).toFixed(3)}" step="0.1" data-number="inPoint" value="${c.inPoint.toFixed(3)}"></label><label>Kết thúc (s)<input type="number" min="${(c.inPoint + LIMITS.minClip).toFixed(3)}" max="${sources.get(c.mediaId)?.duration || c.out}" step="0.1" data-number="out" value="${c.out.toFixed(3)}"></label></div>`;
    }
    html += '</div><div class="group"><h4>FADE IN · FADE OUT</h4>';
    html += field(`Hiện dần ${c.type === 'audio' ? '(âm thanh)' : '(hình + tiếng)'}`, 'fadeIn', 0, Math.min(LIMITS.maxFade, duration), .1, secs, c);
    html += field(`Biến mất dần ${c.type === 'audio' ? '(âm thanh)' : '(hình + tiếng)'}`, 'fadeOut', 0, Math.min(LIMITS.maxFade, duration), .1, secs, c);
    html += '</div>';
    if (c.type !== 'audio') {
      html += '<div class="group"><h4>CHỈNH HÌNH ẢNH</h4>';
      html += field('Độ sáng', 'brightness', -100, 100, 1, plain, c);
      html += field('Tương phản', 'contrast', -100, 100, 1, plain, c);
      html += field('Bão hòa', 'saturation', -100, 100, 1, plain, c);
      html += field('Phơi sáng', 'exposure', -100, 100, 1, plain, c);
      html += field('Nhiệt độ màu', 'temperature', -100, 100, 1, plain, c);
      html += field('Làm mờ', 'blur', 0, 20, .5, v => `${v}px`, c);
      html += `<div class="field"><label>Hiển thị khung</label><select data-field="fit"><option value="contain">Toàn bộ ảnh (Fit)</option><option value="cover">Lấp đầy khung (Fill)</option></select></div>`;
      if (c.type === 'image') html += `<div class="field"><label>Chuyển động ảnh</label><select data-field="motion"><option value="none">Không chuyển động</option><option value="zoom-in">Phóng to dần</option><option value="zoom-out">Thu nhỏ dần</option><option value="pan-left">Di chuyển trái</option><option value="pan-right">Di chuyển phải</option></select></div>`;
      html += '</div>';
    }
    panel.innerHTML = html;
    const mute = panel.querySelector('#toggleMute');
    if (mute) mute.onclick = () => mutate(() => { if (c.volume) { c.lastVolume = c.volume; c.volume = 0; } else c.volume = c.lastVolume || 1; });
    panel.querySelectorAll('[data-rate]').forEach(button => button.onclick = () => mutate(() => { c.speed = Number(button.dataset.rate); c.fadeIn = Math.min(c.fadeIn, clipDuration(c)); c.fadeOut = Math.min(c.fadeOut, clipDuration(c)); }));
    panel.querySelectorAll('[data-number]').forEach(input => {
      input.addEventListener('change', () => {
        const key = input.dataset.number, value = Number(input.value);
        if (!Number.isFinite(value)) return updateInspector();
        const asset = sources.get(c.mediaId);
        const next = key === 'inPoint' ? clamp(value, 0, c.out - LIMITS.minClip) : clamp(value, c.inPoint + LIMITS.minClip, asset.duration);
        mutate(() => { c[key] = next; c.fadeIn = Math.min(c.fadeIn, clipDuration(c)); c.fadeOut = Math.min(c.fadeOut, clipDuration(c)); });
      });
    });
    panel.querySelectorAll('[data-field]').forEach(input => {
      const key = input.dataset.field;
      if (input.tagName === 'SELECT') input.value = c[key];
      let saved = false;
      input.addEventListener('input', () => {
        if (state.exporting) return;
        if (!saved) { checkpoint(); saved = true; }
        if (state.playing) pause();
        const value = input.type === 'range' ? Number(input.value) : input.value;
        c[key] = value;
        if (key === 'out') c.out = Math.max(.25, value);
        const length = clipDuration(c);
        c.fadeIn = Math.min(c.fadeIn, length);
        c.fadeOut = Math.min(c.fadeOut, length);
        state.time = clamp(state.time, 0, timelineDuration());
        const output = panel.querySelector(`[data-output="${key}"]`);
        if (output) output.textContent = key === 'volume' ? percent(c[key]) : key === 'speed' ? `${c[key].toFixed(2)}×` : ['fadeIn', 'fadeOut', 'position', 'out'].includes(key) ? secs(c[key]) : key === 'blur' ? `${c[key]}px` : String(c[key]);
        updateTimeline(); activeVideoId = null;
        renderAt(state.time, false, true);
      });
      input.addEventListener('change', () => updateInspector());
    });
  }
  function refresh() {
    const duration = timelineDuration();
    $('empty').classList.toggle('hidden', !!state.clips.length);
    $('durationLabel').textContent = `${state.clips.length} đoạn · ${fmt(duration)}`;
    updateTimeUI(); updateTimeline(); updateInspector();
    $('undo').disabled = state.history.length === 0;
    $('redo').disabled = state.future.length === 0;
    const c = selectedClip();
    $('delete').disabled = !c; $('duplicate').disabled = !c || c.type === 'audio';
    $('moveLeft').disabled = !c || c.type === 'audio' || state.clips.indexOf(c) === 0;
    $('moveRight').disabled = !c || c.type === 'audio' || state.clips.indexOf(c) >= state.clips.length - 1;
    $('split').disabled = !state.clips.length;
    renderAt(state.time, false, true);
  }
  function split() {
    if (state.exporting) return;
    const item = locate(state.time);
    if (!item) return toast('Đặt playhead bên trong đoạn cần chia.');
    const clip = item.clip, point = clip.inPoint + item.local * clip.speed;
    if (point - clip.inPoint < LIMITS.minClip || clip.out - point < LIMITS.minClip) return toast('Vị trí chia quá sát mép đoạn.');
    mutate(() => {
      const part = { ...clip, id: uid(), inPoint: point, fadeIn: 0 };
      clip.out = point; clip.fadeOut = 0;
      const index = state.clips.indexOf(clip); state.clips.splice(index + 1, 0, part);
      state.selected = part.id;
    });
    toast('Đã chia thành 2 đoạn. Chọn đoạn muốn bỏ và nhấn Delete.');
  }
  function removeSelected() {
    const c = selectedClip(); if (!c) return;
    mutate(() => {
      if (c.type === 'audio') state.audio = state.audio.filter(v => v.id !== c.id);
      else state.clips = state.clips.filter(v => v.id !== c.id);
      state.selected = null;
    });
  }
  function duplicate() {
    const c = selectedClip(); if (!c || c.type === 'audio') return;
    mutate(() => {
      const copy = { ...c, id: uid() }; state.clips.splice(state.clips.indexOf(c) + 1, 0, copy); state.selected = copy.id;
    });
  }
  function shiftClip(direction) {
    const c = selectedClip(), i = state.clips.indexOf(c), j = i + direction;
    if (i < 0 || j < 0 || j >= state.clips.length) return;
    mutate(() => { state.clips.splice(i, 1); state.clips.splice(j, 0, c); });
  }
  async function exportVideo() {
    if (state.exporting || !state.clips.length) return;
    const mime = pickMime($('exportFormat').value);
    if (!mime) return toast('Trình duyệt không hỗ trợ xuất video bằng MediaRecorder.', true);
    const height = Number($('exportSize').value), width = height === 1080 ? 1920 : height === 720 ? 1280 : 854;
    const fps = Number($('exportFps').value), duration = timelineDuration();
    if (duration <= 0) return;
    pause(); state.exporting = true; exportAbort = false;
    $('startExport').disabled = true; $('exportClose').disabled = true;
    $('progressArea').classList.remove('hidden'); $('cancelExport').textContent = 'Hủy xuất';
    const oldWidth = canvas.width, oldHeight = canvas.height;
    let stream = null, recorder = null, chunks = [], completed, finished = false;
    try {
      initAudio(); await audioContext.resume();
      canvas.width = width; canvas.height = height;
      state.time = 0; activeVideoId = null;
      await renderAt(0, false, true);
      const vidStream = canvas.captureStream(fps);
      stream = new MediaStream([...vidStream.getVideoTracks(), ...audioDestination.stream.getAudioTracks()]);
      const bitrate = width >= 1920 ? 8_000_000 : width >= 1280 ? 4_500_000 : 2_000_000;
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate, audioBitsPerSecond: 160_000 });
      completed = new Promise((resolve, reject) => {
        recorder.addEventListener('dataavailable', e => { if (e.data.size) chunks.push(e.data); });
        recorder.addEventListener('error', e => reject(e.error || new Error('Lỗi bộ mã hóa.')));
        recorder.addEventListener('stop', resolve, { once: true });
      });
      // Start clock only after the first source frame has been prepared.
      recorder.start(800);
      state.playing = true;
      let anchor = performance.now();
      let lastClip = null;
      while (true) {
        if (exportAbort) throw new Error('Đã hủy xuất video.');
        if (document.hidden) throw new Error('Tab bị ẩn khi xuất. Hãy giữ QuickCut ở tab đang mở.');
        const t = Math.min(duration, (performance.now() - anchor) / 1000);
        state.time = t;
        const item = locate(Math.min(t, Math.max(0, duration - 0.00001)));
        if (item && item.clip.id !== lastClip) {
          lastClip = item.clip.id;
          if (item.clip.type === 'video') {
            const beforeSeek = performance.now();
            await prepareVideo(item, t, true);
            // Account for source seek time rather than jumping over frames.
            anchor += performance.now() - beforeSeek;
          } else pauseVideoAssets();
        }
        const adjusted = Math.min(duration, (performance.now() - anchor) / 1000);
        state.time = adjusted;
        drawFrame(adjusted);
        updateAudio(adjusted, true);
        updateTimeUI();
        const percentage = Math.min(100, Math.floor(adjusted / duration * 100));
        $('progress').value = percentage; $('progressPercent').textContent = `${percentage}%`;
        $('progressText').textContent = `Đang xuất · ${fmt(adjusted)} / ${fmt(duration)}`;
        if (adjusted >= duration) break;
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      state.playing = false;
      pause();
      $('progressText').textContent = 'Đang hoàn thiện tệp...';
      recorder.stop(); await completed; finished = true;
      if (!chunks.length) throw new Error('Bộ ghi không tạo dữ liệu.');
      const blob = new Blob(chunks, { type: recorder.mimeType || mime });
      if (blob.size < 1024) throw new Error('Tệp xuất quá nhỏ hoặc không hợp lệ.');
      const actualType = recorder.mimeType || mime;
      const ext = actualType.includes('mp4') ? 'mp4' : 'webm';
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `QuickCut-${new Date().toISOString().slice(0, 10)}.${ext}`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      toast(`Hoàn thành! Đã tạo ${ext.toUpperCase()} (${(blob.size / 1024 / 1024).toFixed(1)} MB).`);
      $('modal').classList.add('hidden');
    } catch (e) {
      console.error('Xuất video thất bại', e);
      toast(e.message, true);
      if (recorder?.state === 'recording') { recorder.stop(); await completed.catch(() => {}); }
    } finally {
      state.exporting = false; state.playing = false; pause();
      if (audioContext) for (const s of sources.values()) if (s.audioGain) s.audioGain.gain.value = 0;
      if (stream) stream.getVideoTracks().forEach(t => t.stop());
      canvas.width = oldWidth; canvas.height = oldHeight; state.time = 0;
      activeVideoId = null; activeAudioIds.clear();
      $('startExport').disabled = false; $('exportClose').disabled = false;
      $('progressArea').classList.add('hidden'); $('cancelExport').textContent = 'Đóng';
      refresh();
    }
  }
  function pickMime(preference = 'auto') {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    const candidates = [
      'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
      'video/mp4;codecs="avc1.42E01E"',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus', 'video/webm',
    ];
    const eligible = candidates.filter(v => preference === 'auto' || (preference === 'mp4' ? v.includes('mp4') : v.includes('webm')));
    return eligible.find(v => MediaRecorder.isTypeSupported(v)) || '';
  }
  function openExport() {
    if (!state.clips.length) return toast('Vui lòng thêm ít nhất một video hoặc hình ảnh.');
    pause(); const mime = pickMime($('exportFormat').value);
    $('exportSupport').textContent = mime
      ? `Định dạng: ${mime.includes('mp4') ? 'MP4 (H.264 + âm thanh Opus trên Chrome; có thể không tương thích một số thiết bị)' : 'WebM'} · Ghi và trộn âm thanh cục bộ · Thời gian xuất xấp xỉ thời lượng video.`
      : 'Trình duyệt không hỗ trợ MediaRecorder. Hãy sử dụng Chrome hoặc Edge phiên bản mới.';
    $('startExport').disabled = !mime;
    $('modal').classList.remove('hidden');
  }
  function bind() {
    $('newProject').onclick = clearProject;
    $('addMedia').onclick = $('emptyImport').onclick = () => $('mediaInput').click();
    $('addMusic').onclick = () => $('musicInput').click();
    $('mediaInput').onchange = async e => { await importFiles(e.target.files); e.target.value = ''; };
    $('musicInput').onchange = async e => { await importFiles(e.target.files, 'audio'); e.target.value = ''; };
    $('undo').onclick = undo; $('redo').onclick = redo; $('split').onclick = split; $('delete').onclick = removeSelected;
    $('duplicate').onclick = duplicate; $('moveLeft').onclick = () => shiftClip(-1); $('moveRight').onclick = () => shiftClip(1);
    $('play').onclick = togglePlayback;
    $('back').onclick = () => seekTimeline(state.time - 5);
    $('forward').onclick = () => seekTimeline(state.time + 5);
    $('fullscreen').onclick = () => $('preview').requestFullscreen?.();
    $('zoom').oninput = e => { state.zoom = Number(e.target.value); updateTimeline(); };
    $('exportBtn').onclick = openExport;
    $('exportFormat').onchange = openExport;
    $('startExport').onclick = exportVideo;
    $('exportClose').onclick = () => { if (!state.exporting) $('modal').classList.add('hidden'); };
    $('cancelExport').onclick = () => { if (state.exporting) exportAbort = true; else $('modal').classList.add('hidden'); };
    $('ruler').addEventListener('pointerdown', e => seekTimeline((e.clientX - $('ruler').getBoundingClientRect().left) / state.zoom));
    $('videoTrack').addEventListener('pointerdown', e => { if (e.target === $('videoTrack')) seekTimeline((e.clientX - $('videoTrack').getBoundingClientRect().left) / state.zoom); });
    $('audioTrack').addEventListener('pointerdown', e => { if (e.target === $('audioTrack')) seekTimeline((e.clientX - $('audioTrack').getBoundingClientRect().left) / state.zoom); });
    $('modal').addEventListener('pointerdown', e => { if (e.target === $('modal') && !state.exporting) $('modal').classList.add('hidden'); });
    document.addEventListener('keydown', e => {
      if (e.target.closest('input,textarea,select') || state.exporting) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      else if (e.code === 'Space') { e.preventDefault(); togglePlayback(); }
      else if (e.key.toLowerCase() === 's') split();
      else if (e.key === 'Delete' || e.key === 'Backspace') removeSelected();
      else if (e.key === 'Escape' && !state.exporting) $('modal').classList.add('hidden');
    });
    document.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
    document.addEventListener('drop', async e => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      const fs = [...e.dataTransfer.files];
      await importFiles(fs.filter(f => f.type.startsWith('video/') || f.type.startsWith('image/')));
      await importFiles(fs.filter(f => f.type.startsWith('audio/')), 'audio');
    });
    window.addEventListener('beforeunload', e => { if (state.exporting) { e.preventDefault(); e.returnValue = ''; } });
  }
  bind(); refresh();
  // Test hooks are read-only introspection: no alternate implementation path.
  Object.defineProperty(window, '__quickcutDiagnostics', { value: () => ({ clips: state.clips.map(c => ({ ...c })), audio: state.audio.map(c => ({ ...c })), time: state.time, duration: timelineDuration(), exporting: state.exporting, sources: [...sources.values()].map(a => ({ name: a.file.name, type: a.type, duration: a.duration })) }) });
})();
