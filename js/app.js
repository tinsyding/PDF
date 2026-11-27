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

  const selectAllBtn = document.getElementById('selectAllBtn');
  const selectNoneBtn = document.getElementById('selectNoneBtn');
  const invertSelectionBtn = document.getElementById('invertSelectionBtn');
  const selectOddBtn = document.getElementById('selectOddBtn');
  const selectEvenBtn = document.getElementById('selectEvenBtn');
  const rangeForm = document.getElementById('rangeForm');
  const rangeInput = document.getElementById('rangeInput');

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

      // 默认全选所有页面
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
    handleCardToggle(Number(card.dataset.index), e.shiftKey);
  });

  thumbnailGrid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.page-card');
    if (!card) return;
    e.preventDefault();
    handleCardToggle(Number(card.dataset.index), e.shiftKey);
  });

  // 快捷选页按钮
  selectAllBtn.addEventListener('click', () => {
    for (let i = 0; i < state.totalPages; i++) state.selected.add(i);
    updateSelectionUI();
  });

  selectNoneBtn.addEventListener('click', () => {
    state.selected.clear();
    updateSelectionUI();
  });

  invertSelectionBtn.addEventListener('click', () => {
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
    state.selected.clear();
    for (let i = 0; i < state.totalPages; i += 2) state.selected.add(i);
    updateSelectionUI();
  });

  selectEvenBtn.addEventListener('click', () => {
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
    state.selected = pages;
    updateSelectionUI();
    showToast(`已选中 ${pages.size} 页`, 'info', 1800);
  });

  exportBtn.addEventListener('click', handleExport);
})();
