/* Minimal QR Code encoder (byte mode), following the well-known algorithm from
   Project Nayuki's public-domain QR Code generator. Vendored into the app so a
   share code can be drawn while offline — no CDN and no build step.

   QR.matrix(text, 'M') -> array of rows of booleans (true = dark module).
   QR.toSvgPath(matrix) -> an SVG path covering the dark modules. */
(function (global) {
  'use strict';

  const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };   // format-info value per level
  const ECC_INDEX = { L: 0, M: 1, Q: 2, H: 3 };     // row in the tables below

  // Error-correction codewords per block, rows L/M/Q/H, index = version.
  const ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ];
  // Number of error-correction blocks, same layout.
  const NUM_ECC_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  ];

  const PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

  /* ---- GF(256) arithmetic for Reed-Solomon ---- */
  function gfMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = ((z << 1) ^ ((z >>> 7) * 0x11D)) & 0xFF;
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }

  function eccDivisor(degree) {
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = gfMultiply(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMultiply(root, 0x02);
    }
    return result;
  }

  function eccRemainder(data, divisor) {
    const result = new Uint8Array(divisor.length);
    for (const b of data) {
      const factor = b ^ result[0];
      result.copyWithin(0, 1);
      result[result.length - 1] = 0;
      for (let i = 0; i < divisor.length; i++) result[i] ^= gfMultiply(divisor[i], factor);
    }
    return result;
  }

  /* ---- Capacity ---- */
  function numRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function numDataCodewords(ver, ecc) {
    return Math.floor(numRawDataModules(ver) / 8)
      - ECC_CODEWORDS_PER_BLOCK[ecc][ver] * NUM_ECC_BLOCKS[ecc][ver];
  }

  function appendBits(bits, val, len) {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  }

  /* ---- Data codewords: byte-mode segment, padding, ECC, interleaving ---- */
  function makeCodewords(bytes, ver, ecc) {
    const capacityBits = numDataCodewords(ver, ecc) * 8;
    const bits = [];
    appendBits(bits, 4, 4);                                  // byte mode
    appendBits(bits, bytes.length, ver < 10 ? 8 : 16);       // character count
    for (const b of bytes) appendBits(bits, b, 8);
    appendBits(bits, 0, Math.min(4, capacityBits - bits.length));  // terminator
    appendBits(bits, 0, (8 - bits.length % 8) % 8);               // pad to a byte
    for (let pad = 0xEC; bits.length < capacityBits; pad ^= 0xEC ^ 0x11) appendBits(bits, pad, 8);

    const data = new Uint8Array(bits.length / 8);
    bits.forEach((bit, i) => { data[i >>> 3] |= bit << (7 - (i & 7)); });

    const numBlocks = NUM_ECC_BLOCKS[ecc][ver];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][ver];
    const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - rawCodewords % numBlocks;
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);

    const blocks = [];
    const divisor = eccDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dataLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
      const dat = data.slice(k, k + dataLen);
      k += dataLen;
      const block = Array.from(dat);
      // Short blocks carry a placeholder so every block is the same length;
      // the interleaving below skips it again.
      if (i < numShortBlocks) block.push(0);
      for (const b of eccRemainder(dat, divisor)) block.push(b);
      blocks.push(block);
    }

    // Interleave: one codeword from each block in turn. Short blocks have no
    // data codeword at the last data index, so they are skipped there.
    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
      for (let j = 0; j < blocks.length; j++) {
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i]);
      }
    }
    return result;
  }

  function alignmentPositions(ver, size) {
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  /* ---- Grid ---- */
  function build(bytes, eclName) {
    const ecc = ECC_INDEX[eclName] === undefined ? ECC_INDEX.M : ECC_INDEX[eclName];
    let ver = 1;
    while (ver <= 40) {
      const needed = 4 + (ver < 10 ? 8 : 16) + bytes.length * 8;
      if (needed <= numDataCodewords(ver, ecc) * 8) break;
      ver++;
    }
    if (ver > 40) throw new Error('Tekst past niet in een QR-code');

    const size = ver * 4 + 17;
    const modules = [], isFunction = [];
    for (let y = 0; y < size; y++) {
      modules.push(new Array(size).fill(false));
      isFunction.push(new Array(size).fill(false));
    }

    const setFunction = (x, y, dark) => {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      modules[y][x] = dark;
      isFunction[y][x] = true;
    };

    // Timing patterns.
    for (let i = 0; i < size; i++) {
      setFunction(6, i, i % 2 === 0);
      setFunction(i, 6, i % 2 === 0);
    }
    // Finder patterns plus their separators.
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFunction(cx + dx, cy + dy, dist !== 2 && dist !== 4);
        }
      }
    }
    // Alignment patterns, except where they'd sit on a finder.
    const align = alignmentPositions(ver, size);
    for (let i = 0; i < align.length; i++) {
      for (let j = 0; j < align.length; j++) {
        const onFinder = (i === 0 && j === 0)
          || (i === 0 && j === align.length - 1)
          || (i === align.length - 1 && j === 0);
        if (onFinder) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            setFunction(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }
    // Version info (version 7 and up).
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const bits = ver << 12 | rem;
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) !== 0;
        const a = size - 11 + i % 3, b = Math.floor(i / 3);
        setFunction(a, b, dark);
        setFunction(b, a, dark);
      }
    }
    // Reserve the format-info modules; the real bits follow once a mask is picked.
    drawFormat(modules, isFunction, size, FORMAT_BITS[eclName] === undefined ? 0 : FORMAT_BITS[eclName], 0);

    // Codewords, laid out in the zigzag pattern around the function modules.
    const codewords = makeCodewords(bytes, ver, ecc);
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;                 // skip the vertical timing line
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFunction[y][x] && i < codewords.length * 8) {
            modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }

    // Try all eight masks, keep the grid a scanner reads most easily.
    let best = null, bestPenalty = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const trial = modules.map(row => row.slice());
      drawFormat(trial, null, size, FORMAT_BITS[eclName] === undefined ? 0 : FORMAT_BITS[eclName], mask);
      applyMask(trial, isFunction, mask, size);
      const penalty = penaltyScore(trial, size);
      if (penalty < bestPenalty) { bestPenalty = penalty; best = trial; }
    }
    return best;
  }

  function drawFormat(modules, isFunction, size, formatBits, mask) {
    const data = formatBits << 3 | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const set = (x, y, dark) => {
      modules[y][x] = dark;
      if (isFunction) isFunction[y][x] = true;
    };
    const bit = k => ((bits >>> k) & 1) !== 0;
    for (let k = 0; k <= 5; k++) set(8, k, bit(k));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let k = 9; k < 15; k++) set(14 - k, 8, bit(k));
    for (let k = 0; k < 8; k++) set(size - 1 - k, 8, bit(k));
    for (let k = 8; k < 15; k++) set(8, size - 15 + k, bit(k));
    set(8, size - 8, true);                       // module that is always dark
  }

  function applyMask(modules, isFunction, mask, size) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (isFunction[y][x]) continue;
        let invert = false;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = x * y % 2 + x * y % 3 === 0; break;
          case 6: invert = (x * y % 2 + x * y % 3) % 2 === 0; break;
          case 7: invert = ((x + y) % 2 + x * y % 3) % 2 === 0; break;
        }
        if (invert) modules[y][x] = !modules[y][x];
      }
    }
  }

  /* ---- The four standard penalty rules; lower scores scan more reliably ---- */
  function penaltyScore(m, size) {
    let result = 0;

    for (let y = 0; y < size; y++) {
      let runColor = false, runLen = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x++) {
        if (m[y][x] === runColor) {
          runLen++;
          if (runLen === 5) result += PENALTY_N1;
          else if (runLen > 5) result++;
        } else {
          addRunToHistory(runLen, history, size);
          if (!runColor) result += countFinderPatterns(history) * PENALTY_N3;
          runColor = m[y][x];
          runLen = 1;
        }
      }
      result += terminateAndCount(runColor, runLen, history, size) * PENALTY_N3;
    }

    for (let x = 0; x < size; x++) {
      let runColor = false, runLen = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y++) {
        if (m[y][x] === runColor) {
          runLen++;
          if (runLen === 5) result += PENALTY_N1;
          else if (runLen > 5) result++;
        } else {
          addRunToHistory(runLen, history, size);
          if (!runColor) result += countFinderPatterns(history) * PENALTY_N3;
          runColor = m[y][x];
          runLen = 1;
        }
      }
      result += terminateAndCount(runColor, runLen, history, size) * PENALTY_N3;
    }

    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += PENALTY_N2;
      }
    }

    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + k * PENALTY_N4;
  }

  function addRunToHistory(runLen, history, size) {
    if (history[0] === 0) runLen += size;        // light border before the first run
    history.pop();
    history.unshift(runLen);
  }

  function countFinderPatterns(history) {
    const n = history[1];
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0)
      + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
  }

  function terminateAndCount(runColor, runLen, history, size) {
    if (runColor) {                               // end the dark run first
      addRunToHistory(runLen, history, size);
      runLen = 0;
    }
    addRunToHistory(runLen + size, history, size); // light border after the last run
    return countFinderPatterns(history);
  }

  function toSvgPath(modules) {
    const parts = [];
    for (let y = 0; y < modules.length; y++) {
      for (let x = 0; x < modules.length; x++) {
        if (modules[y][x]) parts.push('M' + x + ',' + y + 'h1v1h-1z');
      }
    }
    return parts.join('');
  }

  global.QR = {
    matrix(text, ecl) {
      return build(Array.from(new TextEncoder().encode(String(text))), ecl || 'M');
    },
    toSvgPath: toSvgPath,
  };
})(typeof window !== 'undefined' ? window : globalThis);
