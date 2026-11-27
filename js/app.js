(function () {
  'use strict';

  const { invertPdfPages, parsePageRange } = window.PDFInverter;
  const pdfjsLib = window.pdfjsLib;

  if (pdfjsLib && pdfjsLib.GlobalWorkerOptions) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  }

  // ===== DOM 引用 =====
  const uploadSection = document.getElementById('uploadSection');
  const workspaceSection = document.getElementById('workspaceSection');
  const headerFileActions = document.getElementById('headerFileActions');
  const fileInfoChip = document.getElementById('fileInfoChip');
  const changeFileBtn = document.getElementById('changeFileBtn');

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');

  const selectionSummary = document.getElementById('selectionSummary');
  const exportBtn = document.getElementById('exportBtn');
  const exportBtnText = document.getElementById('exportBtnText');
  const progressTrack = document.getElementById('progressTrack');
  const progressFill = document.getElementById('progressFill');

  const smartSelectBtn = document.getElementById('smartSelectBtn');
  const selectAllBtn = document.getElementById('selectAllBtn');
  const selectNoneBtn = document.getElementById('selectNoneBtn');
  const invertSelectionBtn = document.getElementById('invertSelectionBtn');
  const selectOddBtn = document.getElementById('selectOddBtn');
  const selectEvenBtn = document.getElementById('selectEvenBtn');
  const rangeForm = document.getElementById('rangeForm');
  const rangeInput = document.getElementById('rangeInput');

  const whitenSlider = document.getElementById('whitenSlider');
  const whitenValue = document.getElementById('whitenValue');
  const autoWhitenBtn = document.getElementById('autoWhitenBtn');
  const resetWhitenBtn = document.getElementById('resetWhitenBtn');
  const enhanceSwatch = document.getElementById('enhanceSwatch');
  const enhanceSwatchDot = document.getElementById('enhanceSwatchDot');
  const enhanceSwatchText = document.getElementById('enhanceSwatchText');
  const pdfWhitenMatrix = document.getElementById('pdfWhitenMatrix');

  const thumbnailGrid = document.getElementById('thumbnailGrid');
  const toastEl = document.getElementById('toast');

  // ===== 应用状态 =====
  const state = {
    fileName: '',
    fileSize: 0,
    pdfBytes: null,       // 保留给 pdf-lib 使用的完整 Uint8Array
    pdfJsDoc: null,       // pdf.js 文档实例
    totalPages: 0,
    selected: new Set(),  // 0-based 选中页码集合
    lastClickedIndex: null,
    whiten: 0,            // 手动去灰底强度 (0 ~ 0.45)
    whitenColor: null,    // 自动识别的背景色 { r, g, b } (0 ~ 0.55)
    detectedDarkPages: null, // 自动扫描缓存的暗底页码数组
    detectedBgColor: null,   // 自动扫描缓存的背景色 { r, g, b }（原色 0~255）
    userTouchedSelection: false,
    userTouchedWhiten: false,
    isAnalyzing: false,
    isExporting: false,
    observer: null,
    renderQueue: [],
    activeRenders: 0,
    renderedPages: new Set(),
    sessionId: 0,         // 防止切换文件后旧渲染任务写入 DOM
  };

  let toastTimer = null;

  function showToast(message, type = 'info', duration = 2600) {
    toastEl.textContent = message;
    toastEl.className = 'toast';
    if (type === 'error') toastEl.classList.add('is-error');
    if (type === 'success') toastEl.classList.add('is-success');
    toastEl.hidden = false;

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, duration);
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function buildOutputFileName(origName) {
    const base = origName.replace(/\.pdf$/i, '') || 'document';
    return `${base}_inverted.pdf`;
  }

  // ===== 清理上一份文档资源 =====
  async function cleanupCurrentDocument() {
    state.sessionId++;
    state.renderQueue = [];
    state.activeRenders = 0;
    state.renderedPages.clear();
    state.selected.clear();
    state.lastClickedIndex = null;
    state.detectedDarkPages = null;
    state.detectedBgColor = null;
    state.userTouchedSelection = false;
    state.userTouchedWhiten = false;
    state.isAnalyzing = false;

    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }

    if (state.pdfJsDoc) {
      try {
        await state.pdfJsDoc.destroy();
      } catch (_err) {
        // 忽略销毁错误
      }
      state.pdfJsDoc = null;
    }

    thumbnailGrid.innerHTML = '';
    rangeInput.value = '';
    resetEnhancement(false);
  }

  // ===== 打开并解析 PDF =====
  async function loadPdfFile(file) {
    if (!file) return;
    if (
      file.type !== 'application/pdf' &&
      !file.name.toLowerCase().endsWith('.pdf')
    ) {
      showToast('请选择有效的 PDF 文件', 'error');
      return;
    }

    try {
      await cleanupCurrentDocument();
      const currentSession = state.sessionId;

      const arrayBuffer = await file.arrayBuffer();
      const rawBytes = new Uint8Array(arrayBuffer);

      // 传给 pdf.js 一份拷贝，防止 Worker 转移导致原 buffer 被 detach
      let pdfJsDoc;
      try {
        pdfJsDoc = await pdfjsLib.getDocument({ data: rawBytes.slice() }).promise;
      } catch (workerErr) {
        // file:// 直接打开时部分浏览器禁止本地 Worker，自动降级为单线程解析
        if (window.location.protocol === 'file:') {
          pdfJsDoc = await pdfjsLib.getDocument({
            data: rawBytes.slice(),
            disableWorker: true,
          }).promise;
        } else {
          throw workerErr;
        }
      }

      if (currentSession !== state.sessionId) {
        await pdfJsDoc.destroy();
        return;
      }

      state.fileName = file.name;
      state.fileSize = file.size;
      state.pdfBytes = rawBytes;
      state.pdfJsDoc = pdfJsDoc;
      state.totalPages = pdfJsDoc.numPages;

      // 初始全选，随后后台自动识别暗底页并更新选中与去灰底强度
      for (let i = 0; i < state.totalPages; i++) {
        state.selected.add(i);
      }

      fileInfoChip.textContent = `${state.fileName} · ${state.totalPages} 页 · ${formatBytes(state.fileSize)}`;
      fileInfoChip.title = state.fileName;

      uploadSection.hidden = true;
      workspaceSection.hidden = false;
      headerFileActions.hidden = false;

      buildThumbnailCards();
      updateSelectionUI();

      // 自动识别暗底页面与去灰底强度
      autoAnalyzeDocument(currentSession, { force: false });
    } catch (err) {
      console.error(err);
      showToast('无法解析该 PDF 文件，请确认文件未损坏或未加密', 'error', 3600);
    }
  }

  // ===== 构建缩略图网格与懒加载观察器 =====
  function buildThumbnailCards() {
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < state.totalPages; i++) {
      const card = document.createElement('div');
      card.className = 'page-card is-selected';
      card.dataset.index = String(i);
      card.setAttribute('role', 'listitem');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-pressed', 'true');
      card.setAttribute('aria-label', `第 ${i + 1} 页，已选择反色`);

      card.innerHTML = `
        <div class="thumb-frame is-loading">
          <canvas class="thumb-canvas"></canvas>
          <span class="page-badge">反色</span>
        </div>
        <div class="page-footer">
          <span>第 ${i + 1} 页</span>
          <span class="page-check" aria-hidden="true">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="2 6.5 4.8 9.2 10 3"></polyline>
            </svg>
          </span>
        </div>
      `;

      fragment.appendChild(card);
    }

    thumbnailGrid.appendChild(fragment);

    // IntersectionObserver 懒加载可视区域缩略图
    state.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const idx = Number(entry.target.dataset.index);
          state.observer.unobserve(entry.target);
          enqueueThumbnailRender(idx, entry.target);
        }
      },
      { rootMargin: '320px 0px' }
    );

    const cards = thumbnailGrid.querySelectorAll('.page-card');
    cards.forEach((card) => state.observer.observe(card));
  }

  function enqueueThumbnailRender(pageIndex, cardEl) {
    if (state.renderedPages.has(pageIndex)) return;
    state.renderedPages.add(pageIndex);
    state.renderQueue.push({ pageIndex, cardEl, sessionId: state.sessionId });
    drainRenderQueue();
  }

  function drainRenderQueue() {
    const MAX_CONCURRENT = 3;
    while (state.activeRenders < MAX_CONCURRENT && state.renderQueue.length > 0) {
      const task = state.renderQueue.shift();
      if (task.sessionId !== state.sessionId) continue;

      state.activeRenders++;
      renderThumbnail(task.pageIndex, task.cardEl, task.sessionId).finally(() => {
        state.activeRenders--;
        drainRenderQueue();
      });
    }
  }

  async function renderThumbnail(pageIndex, cardEl, sessionId) {
    if (!state.pdfJsDoc || sessionId !== state.sessionId) return;

    try {
      const page = await state.pdfJsDoc.getPage(pageIndex + 1);
      if (sessionId !== state.sessionId) return;

      const baseViewport = page.getViewport({ scale: 1 });
      const targetWidth = 300;
      const scale = Math.min(targetWidth / baseViewport.width, 1.5);
      const viewport = page.getViewport({ scale });

      const frame = cardEl.querySelector('.thumb-frame');
      const canvas = cardEl.querySelector('.thumb-canvas');
      const ctx = canvas.getContext('2d', { alpha: false });

      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      // 填充纯白底，与真实 PDF 阅读器视觉一致
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport }).promise;

      if (sessionId === state.sessionId) {
        frame.classList.remove('is-loading');
      }
    } catch (err) {
      if (sessionId === state.sessionId) {
        console.warn(`渲染第 ${pageIndex + 1} 页缩略图失败:`, err);
      }
    }
  }

  // ===== 选中状态更新 =====
  function syncCardElement(cardEl, isSelected) {
    const idx = Number(cardEl.dataset.index);
    cardEl.classList.toggle('is-selected', isSelected);
    cardEl.setAttribute('aria-pressed', String(isSelected));
    cardEl.setAttribute(
      'aria-label',
      `第 ${idx + 1} 页，${isSelected ? '已选择反色' : '保持原样'}`
    );
    const badge = cardEl.querySelector('.page-badge');
    if (badge) {
      badge.textContent = isSelected ? '反色' : '原样';
    }
  }

  function updateSelectionUI() {
    const cards = thumbnailGrid.children;
    for (let i = 0; i < cards.length; i++) {
      syncCardElement(cards[i], state.selected.has(i));
    }

    selectionSummary.textContent = `已选 ${state.selected.size} / ${state.totalPages} 页反色`;
    exportBtn.disabled = state.isExporting || state.selected.size === 0;
  }

  function handleCardToggle(index, shiftKey) {
    if (shiftKey && state.lastClickedIndex !== null) {
      const targetState = !state.selected.has(index);
      const start = Math.min(state.lastClickedIndex, index);
      const end = Math.max(state.lastClickedIndex, index);
      for (let i = start; i <= end; i++) {
        if (targetState) {
          state.selected.add(i);
        } else {
          state.selected.delete(i);
        }
      }
    } else {
      if (state.selected.has(index)) {
        state.selected.delete(index);
      } else {
        state.selected.add(index);
      }
    }
    state.lastClickedIndex = index;
    updateSelectionUI();
  }

  // ===== 增强模块：去灰底（矢量背景漂白） =====
  function rgbToHex(r, g, b) {
    const toHex = (v) =>
      Math.max(0, Math.min(255, Math.round(v * 255)))
        .toString(16)
        .padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
  }

  function getActiveWhitenRgb() {
    if (state.whitenColor) {
      return state.whitenColor;
    }
    if (state.whiten > 0) {
      return { r: state.whiten, g: state.whiten, b: state.whiten };
    }
    return null;
  }

  function updateEnhancementUI() {
    const rgb = getActiveWhitenRgb();

    if (!rgb) {
      thumbnailGrid.style.setProperty('--thumb-invert-filter', 'invert(1)');
      whitenSlider.value = '0';
      whitenValue.textContent = '0%';
      enhanceSwatch.hidden = true;
      resetWhitenBtn.hidden = true;
      return;
    }

    // 与 PDF /ColorDodge(r, g, b) 数学完全等价：output = min(1, Cb / (1 - c))
    const kr = (1 / Math.max(0.25, 1 - rgb.r)).toFixed(4);
    const kg = (1 / Math.max(0.25, 1 - rgb.g)).toFixed(4);
    const kb = (1 / Math.max(0.25, 1 - rgb.b)).toFixed(4);

    if (pdfWhitenMatrix) {
      pdfWhitenMatrix.setAttribute(
        'values',
        `${kr} 0 0 0 0  0 ${kg} 0 0 0  0 0 ${kb} 0 0  0 0 0 1 0`
      );
      thumbnailGrid.style.setProperty(
        '--thumb-invert-filter',
        'invert(1) url(#pdfWhitenFilter)'
      );
    } else {
      const k = Math.max(Number(kr), Number(kg), Number(kb)).toFixed(4);
      thumbnailGrid.style.setProperty(
        '--thumb-invert-filter',
        `invert(1) brightness(${k})`
      );
    }

    const pct = Math.round(Math.max(rgb.r, rgb.g, rgb.b) * 100);
    whitenSlider.value = String(Math.min(45, pct));
    whitenValue.textContent = `${pct}%`;
    resetWhitenBtn.hidden = false;

    if (state.whitenColor) {
      const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
      enhanceSwatchDot.style.backgroundColor = hex;
      enhanceSwatchText.textContent = `底色 ${hex}`;
      enhanceSwatch.hidden = false;
    } else {
      enhanceSwatch.hidden = true;
    }
  }

  function resetEnhancement(notify = true) {
    state.whiten = 0;
    state.whitenColor = null;
    updateEnhancementUI();
    if (notify) {
      showToast('已重置去灰底参数', 'info', 1600);
    }
  }

  /**
   * 采样一页的像素画布（优先复用已渲染缩略图，否则按指定宽度快速离屏渲染）
   */
  async function sampleCanvasForPage(pageIndex, maxWidth = 240) {
    const card = thumbnailGrid.children[pageIndex];
    if (card) {
      const frame = card.querySelector('.thumb-frame');
      const canvas = card.querySelector('.thumb-canvas');
      if (frame && !frame.classList.contains('is-loading') && canvas.width > 0) {
        return canvas;
      }
    }

    if (!state.pdfJsDoc) return null;
    const page = await state.pdfJsDoc.getPage(pageIndex + 1);
    const baseVp = page.getViewport({ scale: 1 });
    const scale = Math.min(maxWidth / baseVp.width, 1);
    const vp = page.getViewport({ scale });
    const offscreen = document.createElement('canvas');
    offscreen.width = Math.max(1, Math.ceil(vp.width));
    offscreen.height = Math.max(1, Math.ceil(vp.height));
    const ctx = offscreen.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, offscreen.width, offscreen.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return offscreen;
  }

  /**
   * 分析画布像素：判断是否为暗底页，并提取暗色主背景 RGB（0~255）
   */
  function analyzeCanvasBackground(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;

    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 4000)));
    const buckets = new Map();
    let totalSampled = 0;
    let darkPixels = 0;

    const padX = width > 8 ? 2 : 0;
    const padY = height > 8 ? 2 : 0;

    for (let y = padY; y < height - padY; y += step) {
      for (let x = padX; x < width - padX; x += step) {
        totalSampled++;
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum < 115) {
          darkPixels++;
        }

        if (r <= 170 && g <= 170 && b <= 170) {
          const kr = (r >> 2) << 2;
          const kg = (g >> 2) << 2;
          const kb = (b >> 2) << 2;
          const key = (kr << 16) | (kg << 8) | kb;
          let entry = buckets.get(key);
          if (!entry) {
            entry = { count: 0, sumR: 0, sumG: 0, sumB: 0 };
            buckets.set(key, entry);
          }
          entry.count++;
          entry.sumR += r;
          entry.sumG += g;
          entry.sumB += b;
        }
      }
    }

    if (totalSampled === 0) {
      return { isDark: false, dominantRgb: null, dominantDarkRatio: 0, darkRatio: 0 };
    }

    let best = null;
    for (const entry of buckets.values()) {
      if (!best || entry.count > best.count) {
        best = entry;
      }
    }

    const darkRatio = darkPixels / totalSampled;
    const dominantDarkRatio = best ? best.count / totalSampled : 0;
    const isDark = darkRatio >= 0.45 || dominantDarkRatio >= 0.35;

    const dominantRgb =
      best && dominantDarkRatio >= 0.18
        ? {
            r: best.sumR / best.count,
            g: best.sumG / best.count,
            b: best.sumB / best.count,
          }
        : null;

    return { isDark, dominantRgb, dominantDarkRatio, darkRatio };
  }

  /**
   * 根据检测到的原始暗背景色（0~255）应用去灰底参数
   * 返回是否应用了非零漂白
   */
  function applyDetectedBgColor(avgRgb) {
    if (!avgRgb || Math.max(avgRgb.r, avgRgb.g, avgRgb.b) <= 6) {
      state.whiten = 0;
      state.whitenColor = null;
      updateEnhancementUI();
      return false;
    }

    // 叠加约 2% 容差，消除压缩噪点导致的边缘残留灰斑
    const margin = 5 / 255;
    state.whiten = 0;
    state.whitenColor = {
      r: Math.min(0.55, avgRgb.r / 255 + margin),
      g: Math.min(0.55, avgRgb.g / 255 + margin),
      b: Math.min(0.55, avgRgb.b / 255 + margin),
    };
    updateEnhancementUI();
    return true;
  }

  /**
   * 后台快速扫描整份 PDF：自动选中暗底页面 + 自动识别去灰底强度
   */
  async function autoAnalyzeDocument(sessionId, { force = false } = {}) {
    if (!state.pdfJsDoc || sessionId !== state.sessionId) return;

    // 已有缓存结果且手动触发“智能选页”时直接复用
    if (force && state.detectedDarkPages !== null) {
      applySmartAnalysisResult({ force: true });
      return;
    }

    if (state.isAnalyzing) return;
    state.isAnalyzing = true;
    smartSelectBtn.disabled = true;

    const total = state.totalPages;
    const darkPages = [];
    const bgSamples = [];
    let scanned = 0;

    const BATCH_SIZE = 4;
    try {
      for (let start = 0; start < total; start += BATCH_SIZE) {
        if (sessionId !== state.sessionId) return;

        const batch = [];
        for (let i = start; i < Math.min(total, start + BATCH_SIZE); i++) {
          batch.push(
            sampleCanvasForPage(i, 80)
              .then((canvas) => {
                if (!canvas || sessionId !== state.sessionId) return;
                const info = analyzeCanvasBackground(canvas);
                if (info.isDark) {
                  darkPages.push(i);
                  if (info.dominantRgb) {
                    bgSamples.push(info.dominantRgb);
                  }
                }
              })
              .catch(() => {})
          );
        }

        await Promise.all(batch);
        if (sessionId !== state.sessionId) return;

        scanned = Math.min(total, start + BATCH_SIZE);
        if (!state.userTouchedSelection || force) {
          selectionSummary.textContent = `正在识别暗底页面 (${scanned}/${total})...`;
        }
      }

      if (sessionId !== state.sessionId) return;

      darkPages.sort((a, b) => a - b);
      state.detectedDarkPages = darkPages;

      // 取暗底页背景色的中位数，避免个别异常页拉偏
      if (bgSamples.length > 0) {
        const median = (arr) => {
          const sorted = arr.slice().sort((a, b) => a - b);
          return sorted[Math.floor(sorted.length / 2)];
        };
        state.detectedBgColor = {
          r: median(bgSamples.map((c) => c.r)),
          g: median(bgSamples.map((c) => c.g)),
          b: median(bgSamples.map((c) => c.b)),
        };
      } else {
        state.detectedBgColor = null;
      }

      applySmartAnalysisResult({ force });
    } finally {
      if (sessionId === state.sessionId) {
        state.isAnalyzing = false;
        smartSelectBtn.disabled = false;
        updateSelectionUI();
      }
    }
  }

  function applySmartAnalysisResult({ force = false } = {}) {
    const darkPages = state.detectedDarkPages || [];
    const shouldApplySelection = force || !state.userTouchedSelection;
    const shouldApplyWhiten = force || !state.userTouchedWhiten;

    if (darkPages.length > 0) {
      if (shouldApplySelection) {
        state.selected = new Set(darkPages);
        updateSelectionUI();
      }

      let whitened = false;
      if (shouldApplyWhiten && state.detectedBgColor) {
        whitened = applyDetectedBgColor(state.detectedBgColor);
      }

      if (shouldApplySelection) {
        const hex = state.detectedBgColor
          ? rgbToHex(
              state.detectedBgColor.r / 255,
              state.detectedBgColor.g / 255,
              state.detectedBgColor.b / 255
            )
          : '';
        const msg = whitened
          ? `已自动选中 ${darkPages.length} / ${state.totalPages} 个暗底页面，并自动去灰底（${hex}）`
          : `已自动选中 ${darkPages.length} / ${state.totalPages} 个暗底页面`;
        showToast(msg, 'success', 3000);
      }
    } else if (shouldApplySelection) {
      // 未检测到暗底页（例如纯白底文档转暗黑阅读），保留全选
      state.selected.clear();
      for (let i = 0; i < state.totalPages; i++) {
        state.selected.add(i);
      }
      updateSelectionUI();
      showToast('未检测到暗底页面，已默认全选', 'info', 2400);
    }
  }

  async function handleAutoWhiten() {
    if (!state.pdfJsDoc) return;

    const targetIndex =
      state.selected.size > 0 ? Math.min(...state.selected) : 0;

    autoWhitenBtn.disabled = true;
    try {
      const canvas = await sampleCanvasForPage(targetIndex, 240);
      if (!canvas) return;

      const { dominantRgb } = analyzeCanvasBackground(canvas);
      if (!dominantRgb) {
        showToast('未检测到明显深色背景，可手动拖动滑块微调', 'info', 2600);
        return;
      }

      state.userTouchedWhiten = true;
      const applied = applyDetectedBgColor(dominantRgb);
      if (!applied) {
        showToast('当前背景已接近纯黑，无需额外去灰底', 'success', 2400);
        return;
      }

      const rawHex = rgbToHex(
        dominantRgb.r / 255,
        dominantRgb.g / 255,
        dominantRgb.b / 255
      );
      showToast(`已识别背景色 ${rawHex}，已自动漂白为纯白底`, 'success', 2800);
    } catch (err) {
      console.error(err);
      showToast('自动识别背景失败，请手动拖动滑块调节', 'error');
    } finally {
      autoWhitenBtn.disabled = false;
    }
  }

  // ===== 导出反色 PDF =====
  async function handleExport() {
    if (state.isExporting || !state.pdfBytes) return;
    if (state.selected.size === 0) {
      showToast('请至少选择 1 页进行反色', 'error');
      return;
    }

    state.isExporting = true;
    exportBtn.disabled = true;
    exportBtnText.textContent = '正在处理...';
    progressTrack.hidden = false;
    progressFill.style.width = '5%';

    try {
      const outputBytes = await invertPdfPages(
        state.pdfBytes,
        state.selected,
        {
          whiten: state.whiten,
          whitenColor: state.whitenColor,
        },
        (done, total) => {
          const pct = Math.max(5, Math.round((done / total) * 90));
          progressFill.style.width = `${pct}%`;
          exportBtnText.textContent = `处理中 (${done}/${total})`;
        }
      );

      progressFill.style.width = '100%';
      const blob = new Blob([outputBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = buildOutputFileName(state.fileName);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      showToast(
        `已完成 ${state.selected.size} 页反色并开始下载（${formatBytes(outputBytes.length)}）`,
        'success',
        3200
      );
    } catch (err) {
      console.error(err);
      showToast('导出失败：该 PDF 可能受加密保护或结构异常', 'error', 3600);
    } finally {
      state.isExporting = false;
      exportBtnText.textContent = '导出反色 PDF';
      exportBtn.disabled = state.selected.size === 0;
      setTimeout(() => {
        progressTrack.hidden = true;
        progressFill.style.width = '0%';
      }, 450);
    }
  }

  // ===== 事件绑定 =====
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  changeFileBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) {
      loadPdfFile(file);
    }
    fileInput.value = '';
  });

  // 支持拖放到上传区或整页窗口
  ['dragenter', 'dragover'].forEach((evt) => {
    window.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('is-dragover');
    });
  });

  ['dragleave', 'drop'].forEach((evt) => {
    window.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt === 'drop' || e.relatedTarget === null) {
        dropzone.classList.remove('is-dragover');
      }
    });
  });

  window.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) {
      loadPdfFile(file);
    }
  });

  // 缩略图事件委托
  thumbnailGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.page-card');
    if (!card) return;
    state.userTouchedSelection = true;
    handleCardToggle(Number(card.dataset.index), e.shiftKey);
  });

  thumbnailGrid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.page-card');
    if (!card) return;
    e.preventDefault();
    state.userTouchedSelection = true;
    handleCardToggle(Number(card.dataset.index), e.shiftKey);
  });

  // 快捷选页按钮
  smartSelectBtn.addEventListener('click', () => {
    autoAnalyzeDocument(state.sessionId, { force: true });
  });

  selectAllBtn.addEventListener('click', () => {
    state.userTouchedSelection = true;
    for (let i = 0; i < state.totalPages; i++) state.selected.add(i);
    updateSelectionUI();
  });

  selectNoneBtn.addEventListener('click', () => {
    state.userTouchedSelection = true;
    state.selected.clear();
    updateSelectionUI();
  });

  invertSelectionBtn.addEventListener('click', () => {
    state.userTouchedSelection = true;
    for (let i = 0; i < state.totalPages; i++) {
      if (state.selected.has(i)) {
        state.selected.delete(i);
      } else {
        state.selected.add(i);
      }
    }
    updateSelectionUI();
  });

  selectOddBtn.addEventListener('click', () => {
    state.userTouchedSelection = true;
    state.selected.clear();
    for (let i = 0; i < state.totalPages; i += 2) state.selected.add(i);
    updateSelectionUI();
  });

  selectEvenBtn.addEventListener('click', () => {
    state.userTouchedSelection = true;
    state.selected.clear();
    for (let i = 1; i < state.totalPages; i += 2) state.selected.add(i);
    updateSelectionUI();
  });

  // 页码范围应用
  rangeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const { pages, error } = parsePageRange(rangeInput.value, state.totalPages);
    if (error) {
      showToast(error, 'error');
      return;
    }
    state.userTouchedSelection = true;
    state.selected = pages;
    updateSelectionUI();
    showToast(`已选中 ${pages.size} 页`, 'info', 1800);
  });

  // 增强模块事件绑定
  whitenSlider.addEventListener('input', () => {
    state.userTouchedWhiten = true;
    state.whitenColor = null;
    state.whiten = Number(whitenSlider.value) / 100;
    updateEnhancementUI();
  });

  autoWhitenBtn.addEventListener('click', handleAutoWhiten);
  resetWhitenBtn.addEventListener('click', () => {
    state.userTouchedWhiten = true;
    resetEnhancement(true);
  });

  exportBtn.addEventListener('click', handleExport);
})();
