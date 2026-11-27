/**
 * 无损矢量 PDF 反色核心引擎（基于 pdf-lib 原地修改）
 *
 * 原理：
 * 不进行光栅化，保留原页面所有矢量文字、图片、书签目录和超链接。
 * 对选中的页面原地执行三层叠加：
 *   1. 底层：覆盖整个 MediaBox 的纯白矩形（补齐 PDF 默认透明背景）
 *   2. 中间层：将原页面内容流封装为 Form XObject（隔离图形状态，防止污染）
 *   3. 顶层：设置 ExtGState 混合模式为 /Difference，覆盖纯白矩形（|Cb - 1| = 1 - Cb）
 */
(function (globalScope) {
  'use strict';

  function getPDFLib() {
    if (typeof globalScope.PDFLib !== 'undefined') {
      return globalScope.PDFLib;
    }
    if (typeof require === 'function') {
      return require('../vendor/pdf-lib.min.js');
    }
    throw new Error('PDFLib 未加载');
  }

  /**
   * 向上查找页面继承的字典属性（如 /Resources 或 /MediaBox）
   */
  function lookupInherited(context, pageNode, keyName) {
    let current = pageNode;
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      const val = current.get(keyName);
      if (val !== undefined) {
        return val;
      }
      const parentRef = current.get(getPDFLib().PDFName.of('Parent'));
      current = parentRef ? context.lookup(parentRef) : null;
    }
    return undefined;
  }

  /**
   * 解码单个内容流为 Uint8Array
   */
  function extractStreamBytes(PDFLib, stream) {
    if (stream instanceof PDFLib.PDFRawStream) {
      try {
        return PDFLib.decodePDFRawStream(stream).decode();
      } catch (_err) {
        return stream.getContents();
      }
    }
    if (typeof stream.getUnencodedContents === 'function') {
      return stream.getUnencodedContents();
    }
    if (typeof stream.getContents === 'function') {
      return stream.getContents();
    }
    return new Uint8Array(0);
  }

  /**
   * 合并多个 Uint8Array，中间以换行符分隔
   */
  function concatByteArrays(chunks) {
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0];

    let totalLen = 0;
    for (let i = 0; i < chunks.length; i++) {
      totalLen += chunks[i].length + (i > 0 ? 1 : 0);
    }
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        merged[offset++] = 10; // '\n'
      }
      merged.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    return merged;
  }

  /**
   * 读取页面的全部原始内容流字节
   */
  function readPageContentBytes(PDFLib, context, pageNode) {
    const contentsObj = pageNode.get(PDFLib.PDFName.of('Contents'));
    if (!contentsObj) {
      return new Uint8Array(0);
    }
    const resolved = context.lookup(contentsObj);
    if (!resolved) {
      return new Uint8Array(0);
    }

    const chunks = [];
    if (resolved instanceof PDFLib.PDFArray) {
      for (let i = 0; i < resolved.size(); i++) {
        const item = context.lookup(resolved.get(i));
        if (item) {
          chunks.push(extractStreamBytes(PDFLib, item));
        }
      }
    } else {
      chunks.push(extractStreamBytes(PDFLib, resolved));
    }
    return concatByteArrays(chunks);
  }

  /**
   * 格式化数字，避免科学计数法写入 PDF 内容流
   */
  function fmtNum(n) {
    if (!Number.isFinite(n)) return '0';
    return Number(n.toFixed(4)).toString();
  }

  /**
   * 对指定页码集合执行原地无损反色
   *
   * @param {Uint8Array|ArrayBuffer} pdfBytes 原始 PDF 字节
   * @param {Set<number>|number[]} selectedPages 需要反色的 0-based 页码集合
   * @param {(done: number, total: number) => void} [onProgress] 进度回调
   * @returns {Promise<Uint8Array>} 反色后的完整 PDF 字节
   */
  async function invertPdfPages(pdfBytes, selectedPages, onProgress) {
    const PDFLib = getPDFLib();
    const { PDFDocument, PDFName } = PDFLib;

    const selectedSet =
      selectedPages instanceof Set ? selectedPages : new Set(selectedPages);

    const pdfDoc = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: true,
    });
    const context = pdfDoc.context;
    const pages = pdfDoc.getPages();
    const totalSelected = selectedSet.size;

    if (totalSelected === 0) {
      return pdfDoc.save({ useObjectStreams: true });
    }

    // 共享一个 /Difference 混合模式的 ExtGState 间接对象
    const gsInvRef = context.register(
      context.obj({
        Type: 'ExtGState',
        BM: 'Difference',
      })
    );

    const transparencyGroup = () =>
      context.obj({
        Type: 'Group',
        S: 'Transparency',
        CS: 'DeviceRGB',
        I: false,
        K: false,
      });

    let processed = 0;

    for (let i = 0; i < pages.length; i++) {
      if (!selectedSet.has(i)) continue;

      const page = pages[i];
      const pageNode = page.node;
      const { x, y, width, height } = page.getMediaBox();
      const x1 = x + width;
      const y1 = y + height;

      // 1. 提取原页面内容流并封装为 Form XObject
      const originalBytes = readPageContentBytes(PDFLib, context, pageNode);
      const origResources =
        lookupInherited(context, pageNode, PDFName.of('Resources')) ||
        context.obj({});

      const formStream = context.flateStream(originalBytes, {
        Type: 'XObject',
        Subtype: 'Form',
        FormType: 1,
        BBox: [x, y, x1, y1],
        Resources: origResources,
        Group: transparencyGroup(),
      });
      const formRef = context.register(formStream);

      // 2. 为页面设置 RGB 透明组与新的独立资源字典（避免与原资源命名冲突）
      pageNode.set(PDFName.of('Group'), transparencyGroup());
      pageNode.set(
        PDFName.of('Resources'),
        context.obj({
          XObject: {
            FmOrig: formRef,
          },
          ExtGState: {
            GSInv: gsInvRef,
          },
        })
      );

      // 3. 构造三层绘制指令流：纯白底 -> 原页面 Form -> /Difference 纯白遮罩
      const rect = `${fmtNum(x)} ${fmtNum(y)} ${fmtNum(width)} ${fmtNum(height)} re`;
      const bgOps = `q\n1 1 1 rg\n${rect}\nf\nQ\n`;
      const fgOps = `q\n/FmOrig Do\nQ\n`;
      const overlayOps = `q\n/GSInv gs\n1 1 1 rg\n${rect}\nf\nQ\n`;

      const bgRef = context.register(context.flateStream(bgOps));
      const fgRef = context.register(context.flateStream(fgOps));
      const overlayRef = context.register(context.flateStream(overlayOps));

      pageNode.set(PDFName.of('Contents'), context.obj([bgRef, fgRef, overlayRef]));

      processed++;
      if (typeof onProgress === 'function') {
        onProgress(processed, totalSelected);
      }
      // 每处理 15 页让出主线程，保持浏览器进度条流畅响应
      if (processed % 15 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    return pdfDoc.save({ useObjectStreams: true });
  }

  /**
   * 解析用户输入的页码范围字符串（1-based），如 "1-3, 5, 8-10"
   *
   * @param {string} input
   * @param {number} totalPages
   * @returns {{ pages: Set<number>, error: string | null }} 0-based 页码集合
   */
  function parsePageRange(input, totalPages) {
    const pages = new Set();
    const trimmed = (input || '').trim();
    if (!trimmed) {
      return { pages, error: null };
    }

    const tokens = trimmed.split(/[,，、\s]+/).filter(Boolean);
    for (const token of tokens) {
      const rangeMatch = token.match(/^(\d+)\s*[-–—~]\s*(\d+)$/);
      if (rangeMatch) {
        let start = parseInt(rangeMatch[1], 10);
        let end = parseInt(rangeMatch[2], 10);
        if (start > end) {
          const tmp = start;
          start = end;
          end = tmp;
        }
        if (start < 1 || end > totalPages) {
          return {
            pages: new Set(),
            error: `页码范围 ${token} 超出总页数（1–${totalPages}）`,
          };
        }
        for (let p = start; p <= end; p++) {
          pages.add(p - 1);
        }
      } else if (/^\d+$/.test(token)) {
        const p = parseInt(token, 10);
        if (p < 1 || p > totalPages) {
          return {
            pages: new Set(),
            error: `页码 ${p} 超出总页数（1–${totalPages}）`,
          };
        }
        pages.add(p - 1);
      } else {
        return {
          pages: new Set(),
          error: `无法识别的页码格式：“${token}”`,
        };
      }
    }

    return { pages, error: null };
  }

  const exported = { invertPdfPages, parsePageRange };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    globalScope.PDFInverter = exported;
  }
})(typeof window !== 'undefined' ? window : globalThis);
