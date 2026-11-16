import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// Fast dependency-free Markdown renderer producing byte-identical output
// to marked 18.1.3 (default options: gfm on, breaks off, pedantic off).
// Written from scratch against the CommonMark 0.31.2 / GFM 0.29 specs
// and the behaviour of the practice reference outputs.

// ---------- small utilities ----------
const CHR = String.fromCharCode;
function isSpace(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'; }
function isDigit(ch) { return ch >= '0' && ch <= '9'; }
function isAlpha(ch) { return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'); }
function isAlnum(ch) { return isAlpha(ch) || isDigit(ch); }
function isPunct(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
function isUnicodePunct(ch) {
  if (isPunct(ch)) return true;
  return UNICODE_PUNCT_RE.test(ch);
}
function isWhitespaceChar(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '\u00a0' || ch === '\u1680' || (ch >= '\u2000' && ch <= '\u200a') || ch === '\u2028' || ch === '\u2029' || ch === '\u202f' || ch === '\u205f' || ch === '\u3000' || ch === '\ufeff';
}

// Escape text content. `&` is left alone when it starts something with the
// shape of an entity reference (&name; / &#123; / &#x1f;) -- marked keeps
// those verbatim in text; a numeric one is decoded to its character.
function escapeText(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '&') {
      const r = entityAt(s, i);
      if (r) { out += r.text; i = r.next; continue; }
      out += '&amp;'; i++; continue;
    }
    if (ch === '<') { out += '&lt;'; i++; continue; }
    if (ch === '>') { out += '&gt;'; i++; continue; }
    if (ch === '"') { out += '&quot;'; i++; continue; }
    if (ch === "'") { out += '&#39;'; i++; continue; }
    out += ch; i++;
  }
  return out;
}

// If s starts an entity-shaped reference at i, return {text, next}.
// Numeric references decode to a character (0 / surrogates -> U+FFFD,
// out of range -> not an entity). Named references pass through verbatim.
function entityAt(s, i) {
  const n = s.length;
  if (s[i] !== '&' || i + 1 >= n) return null;
  if (s[i + 1] === '#') {
    let j = i + 2, hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const start = j;
    while (j < n && (hex ? /[0-9a-fA-F]/.test(s[j]) : isDigit(s[j]))) j++;
    if (j === start || j >= n || s[j] !== ';') return null;
    const num = s.slice(start, j);
    if (num.length > 7) return null;
    const cp = parseInt(num, hex ? 16 : 10);
    if (Number.isNaN(cp) || cp > 0x10ffff) return null;
    let ch = (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) ? '\ufffd' : String.fromCodePoint(cp);
    // A decoded character that is HTML-special is escaped again.
    if (ch === '&') ch = '&amp;';
    else if (ch === '<') ch = '&lt;';
    else if (ch === '>') ch = '&gt;';
    else if (ch === '"') ch = '&quot;';
    else if (ch === "'") ch = '&#39;';
    return { text: ch, next: j + 1 };
  }
  let j = i + 1;
  if (j >= n || !isAlpha(s[j])) return null;
  while (j < n && isAlnum(s[j])) j++;
  if (j >= n || s[j] !== ';') return null;
  return { text: s.slice(i, j + 1), next: j + 1 };
}

// Decode entities inside a value that will be re-escaped later (used for
// link titles / alt text): named entities stay as-is, numeric decode.
function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  let out = '', i = 0;
  while (i < s.length) {
    if (s[i] === '&') {
      const r = entityAt(s, i);
      if (r) { out += r.text; i = r.next; continue; }
    }
    out += s[i]; i++;
  }
  return out;
}

// Escape code content: & < > " ' are escaped, with no entity recognition.
function escapeCode(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&#39;';
    else out += ch;
  }
  return out;
}

// Escape an attribute value: same entity-aware rule as text.
function escapeAttr(s) { return escapeText(s); }

// encodeURI, except that '%' is preserved verbatim (marked keeps both
// bare '%' and existing %XX escapes as-is).
function encodeUrlKeepPct(href) {
  return href.split('%').map(p => { try { return encodeURI(p); } catch (e) { return p; } }).join('%');
}

// Clean a link destination the way marked does: backslash escapes are
// resolved, then URI-encode (spaces, non-ASCII, controls), keeping existing
// %XX sequences and &...; references intact.
function cleanUrl(href) {
  let h = unescapePunct(href);
  h = encodeUrlKeepPct(h);
  return h;
}

// Autolink hrefs are encoded as-is, without resolving backslash escapes.
function cleanUrlRaw(href) {
  return encodeUrlKeepPct(href);
}

// Resolve backslash + ASCII punctuation to the punctuation itself.
function unescapePunct(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '', i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length && isPunct(s[i + 1])) { out += s[i + 1]; i += 2; continue; }
    out += s[i]; i++;
  }
  return out;
}

// Normalise a link-reference label: collapse internal whitespace, fold case.
function normalizeLabel(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

// Split a string into lines on \n / \r\n / \r (line endings are removed).
function splitLines(src) {
  if (src.length === 0) return [''];
  const lines = src.split(/\r\n|\r|\n/);
  // A trailing line ending produces a final empty element that is not a
  // real line (it would add a spurious empty line to a fenced code block).
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// ---------- block parsing ----------
// A block node: {t, ch:[], sl, el, ...type-specific fields}
// Types: doc, bq, list, item, para, heading, fence, code, html, hr, table
function newBlock(t, sl) { return { t, ch: [], sl, el: sl }; }

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Column width of leading whitespace of line starting at pos (tabs expand
// to multiples of 4 from col). Returns {cols, pos} where pos is the index
// of the first non-space/tab char.
function indentOf(line, pos, col) {
  let c = col;
  let p = pos;
  while (p < line.length) {
    const ch = line[p];
    if (ch === ' ') { p++; c++; }
    else if (ch === '\t') { const w = 4 - (c % 4); p++; c += w; }
    else break;
  }
  return { cols: c - col, pos: p };
}

// Strip a fence's own indent from a content line (eff, with cursor cc).
// A tab straddling the indent boundary is removed entirely. When
// expandTabs is true (the fence sits inside a container, so the content
// line starts at a nonzero column), any remaining leading tabs expand to
// spaces from their absolute column; at the document level they are kept
// verbatim.
function stripFenceIndent(eff, cc, indent, expandTabs) {
  let n = indent;
  while (n > 0 && cc.pos < eff.length) {
    const ch = eff[cc.pos];
    if (ch === ' ') { cc.pos++; cc.col++; n--; }
    else if (ch === '\t') {
      const w = 4 - (cc.col % 4);
      if (w <= n) { cc.pos++; cc.col += w; n -= w; }
      else { cc.pos++; cc.col += w; n = 0; }
    } else break;
  }
  if (!expandTabs) return eff.slice(cc.pos);
  let extra = 0;
  let p = cc.pos;
  let c = cc.col;
  while (p < eff.length && (eff[p] === ' ' || eff[p] === '\t')) {
    if (eff[p] === ' ') { extra++; p++; c++; }
    else { const w = 4 - (c % 4); extra += w; p++; c += w; }
  }
  return ' '.repeat(extra) + eff.slice(p);
}

// Advance the cursor (pos,col) by n virtual columns. Returns the number of
// spaces to prepend when a tab is only partially consumed. Tab widths are
// measured from `base` (the column at the start of the current container
// segment): marked expands a tab by its position in the line as it stands
// after the outer containers were stripped, not by its absolute column.
function advanceCols(line, cur, n, base) {
  base = base || 0;
  let pad = 0;
  while (n > 0 && cur.pos < line.length) {
    const ch = line[cur.pos];
    if (ch === ' ') { cur.pos++; cur.col++; n--; }
    else if (ch === '\t') {
      const w = 4 - ((cur.col - base) % 4);
      if (w <= n) { cur.pos++; cur.col += w; n -= w; }
      else { pad = w - n; cur.pos++; cur.col += w; n = 0; }
    } else break;
  }
  return pad;
}

// Expand leading spaces/tabs of s to spaces, measuring tab widths from
// column `col` (the segment-relative column of s's first char).
function expandLeadingTabs(s, col) {
  let i = 0, c = col, out = '';
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
    if (s[i] === ' ') { out += ' '; i++; c++; }
    else { const w = 4 - (c % 4); out += ' '.repeat(w); i++; c += w; }
  }
  return out + s.slice(i);
}

function isBlankLine(line, pos) {
  for (let p = pos; p < line.length; p++) {
    if (line[p] !== ' ' && line[p] !== '\t') return false;
  }
  return true;
}

// A line holding only spaces/tabs with at least one tab.
function isTabOnlyLine(line, pos) {
  let hasTab = false;
  for (let p = pos; p < line.length; p++) {
    const ch = line[p];
    if (ch === '\t') hasTab = true;
    else if (ch !== ' ') return false;
  }
  return hasTab;
}

// Does this paragraph (lines so far) look like a table (header plus a
// delimiter row)? Used to keep a tab-only line as an empty table row.
function paraIsTable(para) {
  const ls = para.lines;
  if (ls.length < 2) return false;
  const delim = parseDelimRow(ls[1]);
  if (!delim) return false;
  if (splitTableRow(ls[0]).length !== delim.length) return false;
  return ls[0].indexOf('|') >= 0 || ls[1].indexOf('|') >= 0;
}

// Does the text at line[pos..] match a setext underline (up to 3 spaces
// indent, then only = or only - (1+), then only spaces)? Returns 1 for '=',
// 2 for '-', 0 otherwise.
function setextLevel(line, pos, col) {
  const ind = indentOf(line, pos, col);
  if (ind.cols > 3) return 0;
  const p = ind.pos;
  if (p >= line.length) return 0;
  const m = line[p];
  if (m !== '=' && m !== '-') return 0;
  let q = p;
  while (q < line.length && line[q] === m) q++;
  for (let r = q; r < line.length; r++) {
    if (line[r] !== ' ' && line[r] !== '\t') return 0;
  }
  return m === '=' ? 1 : 2;
}

// Thematic break: up to 3 spaces indent, then 3+ of the same char (* - _)
// separated only by spaces/tabs.
function isThematicBreak(line, pos, col) {
  const ind = indentOf(line, pos, col);
  if (ind.cols > 3) return false;
  let p = ind.pos;
  if (p >= line.length) return false;
  const m = line[p];
  if (m !== '*' && m !== '-' && m !== '_') return false;
  let count = 0;
  while (p < line.length) {
    const ch = line[p];
    if (ch === m) { count++; p++; }
    else if (ch === ' ' || ch === '\t') p++;
    else return false;
  }
  return count >= 3;
}

// ATX heading at cursor. Returns {level, text} or null.
function atxHeading(line, pos, col) {
  const ind = indentOf(line, pos, col);
  if (ind.cols > 3) return null;
  let p = ind.pos;
  let level = 0;
  while (p < line.length && line[p] === '#' && level < 7) { level++; p++; }
  if (level === 0 || level > 6) return null;
  if (p < line.length && line[p] !== ' ' && line[p] !== '\t') return null;
  let text = line.slice(p).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  // Remove a closing sequence of #s preceded by a space, or the whole
  // text when it consists only of #s.
  const m = /[ \t]+#+$/.exec(text);
  if (m) text = text.slice(0, m.index).replace(/[ \t]+$/, '');
  else if (/^#+$/.test(text)) text = '';
  return { level, text };
}

// Fence start at cursor. Returns {ch, len, info} or null.
function fenceStart(line, pos, col) {
  const ind = indentOf(line, pos, col);
  if (ind.cols > 3) return null;
  const p = ind.pos;
  if (p >= line.length) return null;
  const m = line[p];
  if (m !== '`' && m !== '~') return null;
  let q = p;
  while (q < line.length && line[q] === m) q++;
  const len = q - p;
  if (len < 3) return null;
  const info = line.slice(q).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (m === '`' && info.indexOf('`') >= 0) return null;
  return { ch: m, len, info };
}

// Closing fence check for an open fence (content line at cursor).
function isClosingFence(line, pos, col, fence) {
  const ind = indentOf(line, pos, col);
  if (ind.cols > 3) return false;
  let p = ind.pos;
  let len = 0;
  while (p < line.length && line[p] === fence.fch) { len++; p++; }
  if (len < fence.len) return false;
  for (let r = p; r < line.length; r++) {
    if (line[r] !== ' ' && line[r] !== '\t') return false;
  }
  return true;
}

// HTML block start at cursor. Returns type 1-7 or 0.
// HTML block start. Returns 0 (not a block) or the type 1-6, following
// marked: type 1 is an *open* <pre|script|style|textarea>; types 2-5 are
// comments, processing instructions, declarations and CDATA; type 6 is a
// line starting with a block-level tag, or a line consisting of a single
// tag (any tag name) and nothing else.
function htmlBlockType(line, pos, col) {
  const ind = indentOf(line, pos, col);
  if (ind.cols > 3) return 0;
  const p = ind.pos;
  if (p >= line.length || line[p] !== '<') return 0;
  const rest = line.slice(p);
  const low = rest.toLowerCase();
  if (/^<(script|pre|style|textarea)([ \t>]|$)/.test(low)) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![a-z]/i.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  const tagM = /^<\/?([a-z][a-z0-9-]*)([ \t/>]|$)/i.exec(rest);
  if (tagM) {
    if (BLOCK_TAGS.has(tagM[1].toLowerCase())) return 6;
    // A single tag alone on the line (any tag name) also starts a block.
    const tag = parseHtmlTag(rest, 0);
    if (tag && rest.slice(tag.end).trim() === '') return 6;
  }
  return 0;
}

// Tag name (lowercase) of the first tag on the line, or null.
function htmlTagName(line, pos, col) {
  const ind = indentOf(line, pos, col);
  if (ind.cols > 3) return null;
  const p = ind.pos;
  if (p >= line.length || line[p] !== '<') return null;
  const tagM = /^<\/?([a-z][a-z0-9-]*)([ \t/>]|$)/i.exec(line.slice(p));
  return tagM ? tagM[1].toLowerCase() : null;
}

// End marker for an HTML block type: type 1 returns the tag name (the
// block ends at a line containing </name>), types 2-5 return the literal
// terminator, type 6 returns null (ends at a blank line).
function htmlEndFor(ht, line, pos) {
  if (ht === 1) {
    const ind = indentOf(line, pos, 0);
    const m = /^<([a-z][a-z0-9-]*)/i.exec(line.slice(ind.pos));
    return m ? m[1].toLowerCase() : null;
  }
  if (ht === 2) return '-->';
  if (ht === 3) return '?>';
  if (ht === 4) return '>';
  if (ht === 5) return ']]>';
  return null;
}

// Does this (container-stripped) line end an HTML block of the given type?
function htmlLineHasEnd(line, ht, end) {
  if (ht === 1 && end) {
    const low = line.toLowerCase();
    const idx = low.indexOf('</' + end);
    if (idx < 0) return false;
    let j = idx + 2 + end.length;
    while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
    return j < line.length && line[j] === '>';
  }
  if (ht >= 2 && ht <= 5 && end) return line.indexOf(end) >= 0;
  return false;
}

// List marker at cursor. Returns marker info or null. markerCol and
// contentIndent are absolute virtual columns (line start = 0).
function listMarker(line, pos, col) {
  const ind = indentOf(line, pos, col);
  if (ind.cols > 3) return null;
  const p = ind.pos;
  if (p >= line.length) return null;
  const m = line[p];
  let bullet = false, delim = null, start = 0, width = 0;
  if (m === '-' || m === '+' || m === '*') { bullet = true; width = 1; }
  else if (isDigit(m)) {
    let q = p;
    while (q < line.length && isDigit(line[q])) q++;
    const num = line.slice(p, q);
    if (num.length > 9) return null;
    if (q < line.length && (line[q] === '.' || line[q] === ')')) {
      delim = line[q]; start = parseInt(num, 10); width = q - p + 1;
    } else return null;
  } else return null;
  const markerCol = col + ind.cols;
  // Whitespace after the marker.
  let q = p + width;
  let spCols = 0;
  let c = markerCol + width;
  let r = q;
  while (r < line.length && (line[r] === ' ' || line[r] === '\t')) {
    if (line[r] === ' ') { spCols++; c++; r++; }
    else { const w = 4 - (c % 4); spCols += w; c += w; r++; }
  }
  const empty = r >= line.length;
  if (!empty && spCols === 0) return null; // marker must be followed by whitespace
  let contentIndent;
  if (empty) contentIndent = markerCol + width + 1;
  else if (spCols >= 5) contentIndent = markerCol + width + 1;
  else contentIndent = markerCol + width + spCols;
  return { bullet, delim, start, width, empty, contentIndent, markerCol, markerChar: m, endPos: p + width, endCol: markerCol + width };
}

// Would a block start at (line, pos, col) interrupt an open paragraph?
function interruptsPara(line, pos, col, inItem) {
  if (atxHeading(line, pos, col)) return true;
  if (fenceStart(line, pos, col)) return true;
  const ht = htmlBlockType(line, pos, col);
  if (ht >= 1 && ht <= 5) return true;
  // Type 6 interrupts only when it starts with a block-level tag; a
  // single inline tag alone on the line does not interrupt a paragraph.
  if (ht === 6) {
    const name = htmlTagName(line, pos, col);
    if (name && BLOCK_TAGS.has(name)) return true;
  }
  if (isThematicBreak(line, pos, col)) return true;
  // Blockquote marker.
  const ind = indentOf(line, pos, col);
  if (ind.cols <= 3 && ind.pos < line.length && line[ind.pos] === '>') return true;
  const lm = listMarker(line, pos, col);
  // Inside a list item any list marker interrupts the item's paragraph;
  // elsewhere an ordered list must start with 1.
  if (lm && !lm.empty && (lm.bullet || lm.start === 1 || inItem)) return true;
  return false;
}

// ---------- main block parser ----------
// Lazy paragraph line content inside a blockquote. Implements marked's
// observed behaviour: a lazy setext-underline candidate (= run, or a --
// run) is kept as paragraph text, padded to at least 4 leading spaces
// when the previous line was also lazy with indent < 4 columns; other
// lazy lines are stripped by 4 columns when indented that far (the strip
// amount carries over from the previous lazy line).
function lazyBqContent(line, col, para) {
  const ind = indentOf(line, 0, col);
  const lead = line.slice(0, ind.pos);
  const rest = line.slice(ind.pos);
  // Setext-underline candidate?
  const m = /^(=+|-+)[ \t]*$/.exec(rest);
  if (m && (m[1][0] === '=' || m[1].length === 2)) {
    let content;
    if (lead.startsWith('\t')) {
      if (para.lazy && para.lazyIndent < 4) content = line;
      else { const cur = { pos: 0, col }; advanceCols(line, cur, 4); content = ' '.repeat(0) + line.slice(cur.pos); }
    } else if (para.lazy && para.lazyIndent < 4) {
      const sp = Math.max(4, lead.length);
      content = ' '.repeat(sp) + rest;
    } else content = line;
    para.lazy = true; para.lazyIndent = ind.cols; para.lazyStrip = 0;
    return content;
  }
  const strip = para.lazy ? para.lazyStrip : 4;
  let content;
  if (ind.cols >= strip && strip > 0) {
    const cur = { pos: 0, col };
    const pad = advanceCols(line, cur, strip);
    content = ' '.repeat(pad) + line.slice(cur.pos);
    para.lazyStrip = strip;
  } else { content = line; para.lazyStrip = 0; }
  para.lazy = true; para.lazyIndent = ind.cols;
  return content;
}

// Lazy paragraph line content inside a list item. The line is the
// effective line (after the matched containers); `col` is its starting
// virtual column. If its indent is below the item's remaining content
// indent it is verbatim; otherwise the excess is kept, minus 4 columns
// once when the excess is at least 4.
function lazyItemContent(line, col, item) {
  const ind = indentOf(line, 0, col);
  const ci = item.contentIndent - col;
  if (ind.cols < ci) {
    // Lazy line: an indent of 4+ columns loses 4 columns; a smaller
    // indent is kept verbatim.
    if (ind.cols >= 4) {
      const cur = { pos: 0, col };
      advanceCols(line, cur, 4);
      return line.slice(cur.pos);
    }
    return line;
  }
  let r = ind.cols - ci;
  if (r >= 4) r -= 4;
  return ' '.repeat(r) + line.slice(ind.pos);
}

function parseBlocks(src, refs) {
  const lines = splitLines(src);
  const blankSet = new Set();
  const emptySet = new Set();
  for (let li = 0; li < lines.length; li++) if (lines[li].length === 0) emptySet.add(li);
  const root = newBlock('doc', 0);
  const stack = [root];
  let lastLineBlank = false;

  function top() { return stack[stack.length - 1]; }
  function addChild(parent, child) { parent.ch.push(child); child.el = child.sl; return child; }
  // Finalize (close) the top block, popping it. Paragraphs get ref-def
  // stripping and table detection here.
  function finalizeTop() {
    const b = stack.pop();
    if (b.t === 'para') finalizePara(b);
    if (b.t === 'code') {
      while (b.lines.length && b.lines[b.lines.length - 1] === '') b.lines.pop();
    }
    if (b.t === 'item') {
      // A list item's text is trailing-whitespace trimmed.
      const last = b.ch[b.ch.length - 1];
      if (last && (last.t === 'para' || last.t === 'code' || last.t === 'html')) {
        const ls = last.lines;
        if (ls && ls.length) ls[ls.length - 1] = ls[ls.length - 1].replace(/[ \t]+$/, '');
      }
    }
    return b;
  }
  function closeTo(idx) { while (stack.length > idx) finalizeTop(); }

  // Strip leading link-reference definitions from a paragraph's text.
  // Returns the remaining text.
  function stripRefDefs(text) {
    let pos = 0;
    const n = text.length;
    while (true) {
      let p = pos;
      // Up to 3 spaces indent at line start.
      let sp = 0;
      while (p < n && text[p] === ' ' && sp < 3) { p++; sp++; }
      if (p >= n || text[p] !== '[') break;
      const label = parseLabel(text, p);
      if (!label || !isValidRefLabel(label.text)) break;
      let q = label.end;
      if (q >= n || text[q] !== ':') break;
      q++;
      // Skip spaces/tabs/newlines (at most one line ending) before dest.
      let nl = 0;
      while (q < n && (text[q] === ' ' || text[q] === '\t' || text[q] === '\n')) {
        if (text[q] === '\n') { nl++; if (nl > 1) break; }
        q++;
      }
      if (nl > 1) break;
      if (q >= n) break;
      const dest = parseDest(text, q);
      if (!dest) break;
      q = dest.end;
      // After the destination, the rest of the line must be only spaces,
      // or a title (preceded by at least one space) followed by spaces.
      let title = null;
      let endPos = q; // position just past the consumed definition
      let q2 = q;
      let sp2 = 0;
      while (q2 < n && (text[q2] === ' ' || text[q2] === '\t')) { q2++; sp2++; }
      if (q2 < n && text[q2] !== '\n' && sp2 > 0 &&
          (text[q2] === '"' || text[q2] === "'" || text[q2] === '(')) {
        const t = parseTitle(text, q2);
        if (t) {
          let e = t.end;
          while (e < n && (text[e] === ' ' || text[e] === '\t')) e++;
          if (e >= n || text[e] === '\n') { title = t.value; endPos = e; }
        }
      }
      if (endPos === q) {
        // No valid same-line title: the destination's line must be clean.
        let e = q;
        while (e < n && (text[e] === ' ' || text[e] === '\t')) e++;
        if (e < n && text[e] !== '\n') break; // trailing junk: not a def
        endPos = e;
        // A title may follow on the next line.
        if (e < n && text[e] === '\n') {
          let q3 = e + 1;
          while (q3 < n && (text[q3] === ' ' || text[q3] === '\t')) q3++;
          if (q3 < n && (text[q3] === '"' || text[q3] === "'" || text[q3] === '(')) {
            const t = parseTitle(text, q3);
            if (t) {
              let e2 = t.end;
              while (e2 < n && (text[e2] === ' ' || text[e2] === '\t')) e2++;
              if (e2 >= n || text[e2] === '\n') { title = t.value; endPos = e2; }
            }
          }
        }
      }
      let e = endPos;
      if (e < n && text[e] === '\n') e++; // consume the line ending
      const key = normalizeLabel(label.text);
      if (key.length > 0 && key.length <= 999 && !refs.has(key)) {
        refs.set(key, { href: dest.value, title });
      }
      pos = e;
    }
    return text.slice(pos);
  }

  function finalizePara(b) {
    let text = b.lines.join('\n');
    text = stripRefDefs(text);
    if (text.trim() === '') { b.dead = true; return; }
    const ls = text.split('\n');
    if (ls.length >= 2) {
      const delim = parseDelimRow(ls[1]);
      // The header row must have the same number of cells as the
      // delimiter row, otherwise this is not a table.
      if (delim && splitTableRow(ls[0]).length === delim.length &&
          (ls[0].indexOf('|') >= 0 || ls[1].indexOf('|') >= 0)) {
        const header = splitTableRow(ls[0]);
        const ncols = delim.length;
        const rows = [];
        for (let i = 2; i < ls.length; i++) rows.push(splitTableRow(ls[i]));
        b.t = 'table';
        b.header = header; b.aligns = delim; b.rows = rows; b.ncols = ncols;
        b.text = undefined;
        return;
      }
    }
    b.text = text;
  }

  // segBase: cur.col at the start of the innermost container strip on
  // the current line (set by the container-matching loop); content tab
  // widths are measured from it. Shared with startBlockLoop.
  let segBase = 0;

  // Try to start a new block (or nested containers) at the cursor.
  // Loops while a container (blockquote / list) opens on the same line.
  function startBlockLoop(line, i, cur, pad) {
    while (true) {
      if (isBlankLine(line, cur.pos)) return;
      const t0 = top();
      if (t0 && t0.t === 'list') {
        const lm0 = listMarker(line, cur.pos, cur.col);
        if (!(lm0 && !isThematicBreak(line, cur.pos, cur.col) && ((t0.bullet && lm0.bullet && lm0.markerChar === t0.markerChar) ||
                      (!t0.bullet && !lm0.bullet && lm0.delim === t0.delim)))) {
          stack.pop(); // the list is over
          continue;
        }
      }
      const atx = atxHeading(line, cur.pos, cur.col);
      if (atx) {
        const h = newBlock('heading', i); h.level = atx.level; h.text = atx.text; h.el = i;
        addChild(top(), h);
        return;
      }
      const fs = fenceStart(line, cur.pos, cur.col);
      if (fs) {
        const f = newBlock('fence', i); f.fch = fs.ch; f.len = fs.len; f.info = fs.info; f.lines = [];
        f.indent = indentOf(line, cur.pos, cur.col).cols;
        addChild(top(), f); stack.push(f);
        return;
      }
      const ht = htmlBlockType(line, cur.pos, cur.col);
      if (ht) {
        const h = newBlock('html', i); h.htype = ht; h.lines = [' '.repeat(pad) + line.slice(cur.pos)]; h.el = i;
        h.end = htmlEndFor(ht, line, cur.pos);
        addChild(top(), h);
        // Types 1-5 end when a line contains the end marker; if the
        // first line already has it, the block is complete. Type 6 ends
        // at a blank line.
        if (ht === 6 || !htmlLineHasEnd(h.lines[0], ht, h.end)) stack.push(h);
        return;
      }
      if (isThematicBreak(line, cur.pos, cur.col)) {
        const h = newBlock('hr', i); h.el = i; addChild(top(), h);
        return;
      }
      const lm = listMarker(line, cur.pos, cur.col);
      if (lm) {
        let list = null;
        const t = top();
        if (t && t.t === 'list' && ((t.bullet && lm.bullet && lm.markerChar === t.markerChar) ||
                                    (!t.bullet && !lm.bullet && lm.delim === t.delim))) list = t;
        if (!list) {
          list = newBlock('list', i);
          list.bullet = lm.bullet; list.delim = lm.delim; list.start = lm.start; list.markerChar = lm.markerChar;
          addChild(top(), list);
          stack.push(list);
        }
        const item = newBlock('item', i);
        item.contentIndent = lm.contentIndent;
        addChild(list, item);
        stack.push(item);
        if (lm.empty) return;
        const cc = { pos: lm.endPos, col: lm.endCol };
        const pd = advanceCols(line, cc, lm.contentIndent - lm.endCol);
        cur.pos = cc.pos; cur.col = cc.col; pad = pd;
        continue;
      }
      const ind = indentOf(line, cur.pos, cur.col);
      if (ind.cols <= 3 && ind.pos < line.length && line[ind.pos] === '>') {
        const bq = newBlock('bq', i);
        addChild(top(), bq);
        stack.push(bq);
        segBase = cur.col;
        cur.pos = ind.pos + 1; cur.col += ind.cols + 1;
        if (cur.pos < line.length) {
          if (line[cur.pos] === ' ') { cur.pos++; cur.col++; pad = 0; }
          else if (line[cur.pos] === '\t') { pad = advanceCols(line, cur, 1, segBase); }
          if (cur.pos < line.length && line[cur.pos] === '\t') {
            const w = 4 - ((cur.col - segBase) % 4);
            pad += w; cur.pos++; cur.col += w;
          }
        } else pad = 0;
        continue;
      }
      // Indented code: the effective line (container pad + rest) must be
      // indented by 4 columns; strip exactly 4.
      {
        const eff = ' '.repeat(pad) + line.slice(cur.pos);
        const effCol = cur.col - pad;
        const eind = indentOf(eff, 0, effCol);
        if (eind.cols >= 4) {
          const code = newBlock('code', i); code.lines = [];
          const cc = { pos: 0, col: effCol };
          const pd = advanceCols(eff, cc, 4);
          code.lines.push(' '.repeat(pd) + eff.slice(cc.pos));
          code.el = i;
          addChild(top(), code);
          stack.push(code);
          return;
        }
      }
      const p = newBlock('para', i);
      p.lines = [expandLeadingTabs(' '.repeat(pad) + line.slice(cur.pos), cur.col - pad)];
      p.lazy = false; p.lazyIndent = 0; p.lazyStrip = 0;
      p.el = i;
      addChild(top(), p);
      stack.push(p);
      return;
    }
  }

  // ---- per-line processing ----
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Container matching.
    const cur = { pos: 0, col: 0 };
    let pad = 0;
    // segBase: cur.col at the start of the innermost container strip so
    // far; tab widths in content are measured from it (see advanceCols).
    segBase = 0;
    let failedIdx = -1, failedType = null;
    for (let s = 1; s < stack.length; s++) {
      const b = stack[s];
      if (b.t === 'para' || b.t === 'fence' || b.t === 'code' || b.t === 'html' ||
          b.t === 'heading' || b.t === 'hr' || b.t === 'table') break;
      if (b.t === 'list') continue;
      // A blank line matches a list item (keeping the list open) but does
      // not match a blockquote unless it carries a '>' prefix.
      if (b.t === 'item' && isBlankLine(line, cur.pos)) continue;
      if (b.t === 'bq') {
        segBase = cur.col;
        const ind = indentOf(line, cur.pos, cur.col);
        if (ind.cols > 3 || ind.pos >= line.length || line[ind.pos] !== '>') { failedIdx = s; failedType = 'bq'; break; }
        cur.pos = ind.pos + 1; cur.col += ind.cols + 1;
        if (cur.pos < line.length) {
          if (line[cur.pos] === ' ') { cur.pos++; cur.col++; }
          else if (line[cur.pos] === '\t') { pad = advanceCols(line, cur, 1, segBase); }
          // A tab right after the '>' marker (and its optional space)
          // is expanded here, measured from the segment column: marked
          // expands it by its position in the line as it stands after
          // the outer containers were stripped.
          if (cur.pos < line.length && line[cur.pos] === '\t') {
            const w = 4 - ((cur.col - segBase) % 4);
            pad += w; cur.pos++; cur.col += w;
          }
        }
      } else if (b.t === 'item') {
        segBase = cur.col;
        const ind = indentOf(line, cur.pos, cur.col);
        const required = b.contentIndent - cur.col;
        if (ind.cols < required) { failedIdx = s; failedType = 'item'; break; }
        pad = advanceCols(line, cur, required);
      }
    }

    if (failedIdx >= 0) {
      const t = top();
      // A fenced code block inside a list item absorbs a line that fails
      // to match the item (its content need not be indented to the item),
      // unless the line is a closing fence for it (which must match).
      // But the fence's first content line must match the item: if the
      // fence is still empty, an unindented line ends the fence (and the
      // item) instead of being absorbed.
      if (t && t.t === 'fence' && failedType === 'item' && t.lines.length > 0 && !isClosingFence(line, cur.pos, cur.col, t)) {
        const eff = ' '.repeat(pad) + line.slice(cur.pos);
        const cc = { pos: 0, col: cur.col - pad };
        t.lines.push(stripFenceIndent(eff, cc, t.indent || 0, cc.col > 0));
        t.el = i;
        lastLineBlank = false;
        continue;
      }
      // A blank line never lazily continues a paragraph; it just closes
      // the containers it fails to match.
      if (isBlankLine(line, cur.pos)) {
        blankSet.add(i);
        closeTo(failedIdx);
        lastLineBlank = true;
        continue;
      }
      const lazyOk = t && t.t === 'para';
      // A list marker is never a lazy continuation of a paragraph inside
      // a list item (it starts a new item or a new list instead).
      const isListMarker = failedType === 'item' && listMarker(line, cur.pos, cur.col);
      const paraParent = stack.length >= 2 ? stack[stack.length - 2] : null;
      if (lazyOk && !isListMarker && !interruptsPara(line, cur.pos, cur.col, paraParent && paraParent.t === 'item')) {
        // Lazy continuation line: the content is the line after the
        // containers that did match.
        const para = t;
        const container = stack[failedIdx];
        const effLine = ' '.repeat(pad) + line.slice(cur.pos);
        const effCol = cur.col - pad;
        let content;
        if (failedType === 'bq') content = lazyBqContent(effLine, effCol, para);
        else content = lazyItemContent(effLine, effCol, container);
        para.lines.push(content);
        para.el = i;
        lastLineBlank = false;
        continue;
      }
      // Not lazy: close containers from the failed one up. A failed item
      // whose line starts a matching new item keeps its list open.
      if (failedType === 'item' && !isThematicBreak(line, cur.pos, cur.col)) {
        const list = stack[failedIdx - 1];
        const lm = listMarker(line, cur.pos, cur.col);
        if (lm && list && list.t === 'list' &&
            ((list.bullet && lm.bullet && lm.markerChar === list.markerChar) ||
             (!list.bullet && !lm.bullet && lm.delim === list.delim))) {
          closeTo(failedIdx); // pop item (and leaf) only, keep the list
          const item = newBlock('item', i);
          item.contentIndent = lm.contentIndent;
          addChild(list, item);
          stack.push(item);
          if (!lm.empty) {
            const cc = { pos: lm.endPos, col: lm.endCol };
            const pd = advanceCols(line, cc, lm.contentIndent - lm.endCol);
            startBlockLoop(line, i, cc, pd);
          }
          lastLineBlank = false;
          continue;
        }
      }
      closeTo(failedIdx);
      startBlockLoop(line, i, cur, pad);
      lastLineBlank = false;
      continue;
    }

    // All containers matched.
    if (isBlankLine(line, cur.pos)) {
      blankSet.add(i);
      // A blank line inside a blockquote extends the blockquote's span
      // (so a '>'-only line inside a blockquote does not make an
      // enclosing list loose). List/item spans are not extended: a
      // blank line between items must still make the list loose.
      for (let si = stack.length - 1; si >= 0; si--) {
        const sb = stack[si];
        if (sb.t === 'bq') sb.el = i;
      }
      // A blank line closes an empty list item: it cannot gain content
      // after a blank line, so a following indented line is outside it.
      while (top() && top().t === 'item' && top().ch.length === 0) stack.pop();
      const t = top();
      // A '>'-only line at the end of a blockquote paragraph contributes
      // the spaces after '>' to the paragraph, unless the next line
      // also carries '>' (then it separates two paragraphs).
      if (t && t.t === 'para' && stack.length >= 2 && stack[stack.length - 2].t === 'bq') {
        const rest = line.slice(cur.pos);
        if (rest.length > 0) {
          let nextHasGt = false;
          if (i + 1 < lines.length) {
            const nl = lines[i + 1];
            let p = 0;
            while (p < nl.length && nl[p] === ' ' && p < 3) p++;
            if (nl[p] === '>') nextHasGt = true;
          }
          if (!nextHasGt) {
            blankSet.delete(i);
            t.lines.push(rest);
            t.el = i;
            lastLineBlank = false;
            continue;
          }
        }
      }
      // A tab-only line inside a table paragraph is an empty table row,
      // not a blank line (a spaces-only or empty line does end the table).
      if (t && t.t === 'para' && isTabOnlyLine(line, cur.pos) && paraIsTable(t)) {
        blankSet.delete(i);
        t.lines.push(' '.repeat(pad) + line.slice(cur.pos));
        t.el = i;
        lastLineBlank = false;
        continue;
      }
      if (t && t.t === 'fence') {
        // A blank line inside a fence keeps its content (after the
        // container prefix), minus the fence's own indent.
        const eff = ' '.repeat(pad) + line.slice(cur.pos);
        const cc = { pos: 0, col: cur.col - pad };
        t.lines.push(stripFenceIndent(eff, cc, t.indent || 0, cc.col > 0));
        t.el = i;
      }
      else if (t && t.t === 'code') {
        // A blank line inside a code block keeps its content past the
        // 4-column code indent.
        const eff = ' '.repeat(pad) + line.slice(cur.pos);
        const effCol = cur.col - pad;
        const ind = indentOf(eff, 0, effCol);
        if (ind.cols >= 4) {
          const cc = { pos: 0, col: effCol };
          const pd = advanceCols(eff, cc, 4);
          t.lines.push(' '.repeat(pd) + eff.slice(cc.pos));
        } else t.lines.push('');
        t.el = i;
      }
      else {
        if (t && (t.t === 'para' || t.t === 'fence' || t.t === 'code')) finalizeTop();
        else if (t && t.t === 'html') {
          if (t.htype === 6) finalizeTop(); // type 6 ends at a blank line
          else { t.lines.push(' '.repeat(pad) + line.slice(cur.pos)); t.el = i; } // types 1-5: blank is content
        }
        lastLineBlank = true;
      }
      continue;
    }

    // Leaf continuation.
    const t = top();
    if (t && t.t === 'para') {
      const sl = setextLevel(line, cur.pos, cur.col);
      // A paragraph that is already a table (header + delimiter row)
      // never becomes a setext heading: a '==='/'---' line is a table
      // row, not an underline.
      if (sl && !paraIsTable(t)) {
        // Link reference definitions are stripped before deciding whether
        // this is a setext heading: a paragraph that is only definitions
        // cannot become a heading.
        const text = stripRefDefs(t.lines.join('\n'));
        if (text.trim() !== '') {
          t.lines = [];
          t.t = 'heading'; t.level = sl; t.text = text.trim(); t.el = i;
          stack.pop();
          lastLineBlank = false;
          continue;
        }
        // Not a heading: the line is paragraph text.
      }
      if (interruptsPara(line, cur.pos, cur.col, stack.length >= 2 && stack[stack.length - 2].t === 'item')) {
        finalizeTop();
        startBlockLoop(line, i, cur, pad);
        lastLineBlank = false;
        continue;
      }
      t.lines.push(expandLeadingTabs(' '.repeat(pad) + line.slice(cur.pos), cur.col - pad));
      t.el = i; t.lazy = false;
      lastLineBlank = false;
      continue;
    }
    if (t && t.t === 'fence') {
      if (isClosingFence(line, cur.pos, cur.col, t)) { stack.pop(); }
      else {
        // Strip up to the fence's own indent from the content line.
        const eff = ' '.repeat(pad) + line.slice(cur.pos);
        const cc = { pos: 0, col: cur.col - pad };
        t.lines.push(stripFenceIndent(eff, cc, t.indent || 0, cc.col > 0));
        t.el = i;
      }
      lastLineBlank = false;
      continue;
    }
    if (t && t.t === 'code') {
      const eff = ' '.repeat(pad) + line.slice(cur.pos);
      const effCol = cur.col - pad;
      const ind = indentOf(eff, 0, effCol);
      if (ind.cols >= 4) {
        const cc = { pos: 0, col: effCol };
        const pd = advanceCols(eff, cc, 4);
        t.lines.push(' '.repeat(pd) + eff.slice(cc.pos));
        t.el = i;
      } else {
        finalizeTop();
        startBlockLoop(line, i, cur, pad);
      }
      lastLineBlank = false;
      continue;
    }
    if (t && t.t === 'html') {
      const content = ' '.repeat(pad) + line.slice(cur.pos);
      t.lines.push(content);
      t.el = i;
      if (t.htype !== 6 && htmlLineHasEnd(content, t.htype, t.end)) stack.pop();
      lastLineBlank = false;
      continue;
    }

    startBlockLoop(line, i, cur, pad);
    lastLineBlank = false;
  }
  closeTo(1);
  root.blankSet = blankSet;
  root.emptySet = emptySet;
  root.totalLines = lines.length;
  root.endsWithNewline = src.endsWith('\n') || src.endsWith('\r');
  return root;
}

// ---------- link label / destination / title parsing ----------
// Does a link label contain a code span (backtick run of length >= 2)
// whose content holds a backtick and which is followed by more label
// text? marked does not form a link from such a label (probed:
// '[a ``x ` y`` b](...)' is literal, '[a ``x ` y``](...)' forms).
function labelHasBadCodeSpan(text) {
  let i = 0;
  while (i < text.length) {
    if (text[i] === '`') {
      let j = i;
      while (j < text.length && text[j] === '`') j++;
      const run = j - i;
      if (run >= 2) {
        let k = j, found = -1, closeStart = -1;
        while (k < text.length) {
          if (text[k] === '`') {
            let e = k;
            while (e < text.length && text[e] === '`') e++;
            if (e - k === run) { found = e; closeStart = k; break; }
            k = e;
          } else k++;
        }
        if (found >= 0) {
          if (text.slice(j, closeStart).indexOf('`') >= 0 && found < text.length) return true;
          i = found;
          continue;
        }
      }
      i = j;
      continue;
    }
    i++;
  }
  return false;
}

// Parse a link label starting at s[i] === '['. Returns {text, end} where
// end is the index just after the matching ']', or null. Brackets must
// balance (code spans are skipped); the label is at most 999 chars.
function parseLabel(s, i) {
  let depth = 1, j = i + 1;
  const n = s.length;
  while (j < n) {
    const ch = s[j];
    if (ch === '\\' && j + 1 < n) { j += 2; continue; }
    // A '<...>' construct (tag or autolink) is skipped whole: a ']'
    // inside it is not the label closer. If there is no '>' at all,
    // the '<' is literal text.
    if (ch === '<') {
      const gt = s.indexOf('>', j + 1);
      if (gt < 0) { j++; continue; }
      j = gt + 1; continue;
    }
    if (ch === '`') {
      let k = j;
      while (k < n && s[k] === '`') k++;
      const run = k - j;
      let e = k, found = -1;
      while (e < n) {
        if (s[e] === '\n') break;
        if (s[e] === '`') {
          let f = e;
          while (f < n && s[f] === '`') f++;
          if (f - e === run) { found = f; break; }
          e = f;
        } else e++;
      }
      // If no closing run of this length exists, only the first
      // backtick is literal: a later backtick of the same run may
      // still open a shorter code span (e.g. '[run ``response`]'
      // closes its label at the ']' after 'response').
      if (found >= 0) { j = found; continue; }
      j++; continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        const text = s.slice(i + 1, j);
        if (text.length > 999) return null;
        return { text, end: j + 1 };
      }
    }
    j++;
  }
  return null;
}

// A reference label (for a shortcut/full reference or a definition) is
// valid only if it is non-empty, not whitespace-only, and contains no
// unescaped '[' except as part of an image '!['. Code spans are skipped.
function isValidRefLabel(text) {
  if (text.trim().length === 0) return false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '`') {
      let k = i;
      while (k < text.length && text[k] === '`') k++;
      const run = k - i;
      let e = k, found = -1;
      while (e < text.length) {
        if (text[e] === '\n') break;
        if (text[e] === '`') {
          let f = e;
          while (f < text.length && text[f] === '`') f++;
          if (f - e === run) { found = f; break; }
          e = f;
        } else e++;
      }
      if (found >= 0) { i = found - 1; continue; }
      continue;
    }
    if (ch === '[') {
      if (i > 0 && text[i - 1] === '!') continue;
      return false;
    }
  }
  return true;
}

// Parse a link destination starting at s[i]. Returns {value, end} or null.
function parseDest(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s[i] === '<') {
    let j = i + 1;
    while (j < n) {
      const ch = s[j];
      if (ch === '\\' && j + 1 < n && isPunct(s[j + 1])) { j += 2; continue; }
      if (ch === '<' || ch === '\n' || ch === '\r') return null;
      if (ch === '>') return { value: s.slice(i + 1, j), end: j + 1 };
      j++;
    }
    return null;
  }
  let j = i, depth = 0;
  while (j < n) {
    const ch = s[j];
    if (ch === '\\' && j + 1 < n && isPunct(s[j + 1])) { j += 2; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch.charCodeAt(0) < 32) break;
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) break;
      depth--;
    }
    j++;
  }
  if (j === i) return null;
  return { value: s.slice(i, j), end: j };
}

// Parse a link title starting at s[i] ('"', "'" or '(').
// Returns {value, end} or null.
function parseTitle(s, i) {
  const n = s.length;
  const q = s[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < n) {
      const ch = s[j];
      if (ch === '\\' && j + 1 < n && isPunct(s[j + 1])) { j += 2; continue; }
      if (ch === q) return { value: s.slice(i + 1, j), end: j + 1 };
      j++;
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1, depth = 1;
    while (j < n) {
      const ch = s[j];
      if (ch === '\\' && j + 1 < n && isPunct(s[j + 1])) { j += 2; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) return { value: s.slice(i + 1, j), end: j + 1 }; }
      j++;
    }
    return null;
  }
  return null;
}

// ---------- table helpers ----------
// Split a table row line into raw cells (outer pipes dropped).
function splitTableRowRaw(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < n) { cur += line[i] + line[i + 1]; i += 2; continue; }
    if (ch === '`') {
      let j = i;
      while (j < n && line[j] === '`') j++;
      const run = j - i;
      let k = j, found = -1;
      while (k < n) {
        if (line[k] === '\\' && k + 1 < n) { k += 2; continue; }
        // A code span cannot cross a cell separator: an unescaped '|'
        // before the closing run means the run is literal text.
        if (line[k] === '|') break;
        if (line[k] === '`') {
          let e = k;
          while (e < n && line[e] === '`') e++;
          if (e - k === run) { found = e; break; }
          k = e;
        } else k++;
      }
      if (found >= 0) { cur += line.slice(i, found); i = found; continue; }
      cur += line.slice(i, j); i = j; continue;
    }
    if (ch === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  cells.push(cur);
  if (/^\s*\|/.test(line)) cells.shift();
  if (/\|\s*$/.test(line)) cells.pop();
  return cells;
}

function splitTableRow(line) { return splitTableRowRaw(line).map(c => c.replace(/\\\|/g, '|').trim()); }

// If line is a table delimiter row, return the alignments array
// ('left' | 'right' | 'center' | null per column), else null.
function parseDelimRow(line) {
  const cells = splitTableRowRaw(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const c of cells) {
    const t = c.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    aligns.push(t.startsWith(':') && t.endsWith(':') ? 'center' : t.startsWith(':') ? 'left' : t.endsWith(':') ? 'right' : null);
  }
  return aligns;
}

// ---------- inline parsing ----------
function escChar(c) {
  if (c === '&') return '&amp;';
  if (c === '<') return '&lt;';
  if (c === '>') return '&gt;';
  if (c === '"') return '&quot;';
  if (c === "'") return '&#39;';
  return c;
}

// Scan a URL (autolink) starting at j. Stops at whitespace, < > " ' `,
// control chars, or an entity reference. Parens are included verbatim;
// trailing unbalanced ')' is trimmed by trimAutolink.
function scanUrl(s, j) {
  const n = s.length;
  let k = j;
  while (k < n) {
    const ch = s[k];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '<' || ch === '>' || ch === '"' || ch === "'" || ch === '`' || ch.charCodeAt(0) < 32) break;
    if (ch === '&' && entityAt(s, k)) break;
    k++;
  }
  return { end: k };
}

// Trim an autolink's trailing punctuation and unmatched '('.
function trimAutolink(text) {
  let t = text;
  let depth = 0, firstUnmatched = -1;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '(') { if (depth === 0) firstUnmatched = i; depth++; }
    else if (t[i] === ')') { if (depth > 0) { depth--; if (depth === 0) firstUnmatched = -1; } }
  }
  if (depth > 0 && firstUnmatched >= 0) t = t.slice(0, firstUnmatched);
  while (t.length > 0) {
    const last = t[t.length - 1];
    if (last === '?' || last === '!' || last === '.' || last === ',' || last === ':' || last === ';' || last === '*' || last === '_' || last === '~') { t = t.slice(0, -1); continue; }
    // Keep a trailing ')' only if some '(' before it is still
    // unmatched (a ')' with no open '(' does not count against it).
    if (last === ')') {
      let bal = 0;
      for (let i = 0; i < t.length - 1; i++) {
        if (t[i] === '(') bal++;
        else if (t[i] === ')' && bal > 0) bal--;
      }
      if (bal === 0) { t = t.slice(0, -1); continue; }
    }
    break;
  }
  return t;
}

// Is an extended autolink allowed to start at i (preceding char rule)?
// Allowed: start of string, whitespace, or one of * _ ~ ( ; or directly
// after an inline HTML tag token. A scheme URL (http/https/ftp) may also
// follow a literal '<' (e.g. a failed <scheme:...> autolink); a www.
// autolink may not.
function autolinkAllowed(s, i, out, buf, allowLt) {
  if (i === 0) return true;
  const prev = s[i - 1];
  if (isWhitespaceChar(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(') return true;
  if (allowLt && prev === '<') return true;
  if (buf === '' && out.length > 0 && out[out.length - 1].k === 'html') return true;
  return false;
}

const OPEN_TAG_RE = /^<[A-Za-z][A-Za-z0-9-]*(?:[ \t\r\n\f]+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:[ \t\r\n\f]*=[ \t\r\n\f]*(?:[^ \t\r\n"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t\r\n\f]*\/?>/;
const CLOSE_TAG_RE = /^<\/[A-Za-z][A-Za-z0-9-]*[ \t\r\n\f]*\/?>/;

function parseHtmlTag(s, i) {
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return { text: '<!-->', end: i + 5 };
    if (s.startsWith('<!--->', i)) return { text: '<!--->', end: i + 6 };
    const e = s.indexOf('-->', i + 4);
    if (e < 0) return null;
    return { text: s.slice(i, e + 3), end: e + 3 };
  }
  if (s.startsWith('<?', i)) {
    const e = s.indexOf('?>', i + 2);
    if (e < 0) return null;
    return { text: s.slice(i, e + 2), end: e + 2 };
  }
  if (s.startsWith('<![CDATA[', i)) {
    const e = s.indexOf(']]>', i + 9);
    if (e < 0) return null;
    return { text: s.slice(i, e + 3), end: e + 3 };
  }
  if (s.startsWith('<!', i) && i + 2 < s.length && isAlpha(s[i + 2])) {
    const e = s.indexOf('>', i + 2);
    if (e < 0) return null;
    return { text: s.slice(i, e + 1), end: e + 1 };
  }
  const sub = s.slice(i);
  let m = OPEN_TAG_RE.exec(sub);
  if (m) return { text: m[0], end: i + m[0].length };
  m = CLOSE_TAG_RE.exec(sub);
  if (m) return { text: m[0], end: i + m[0].length };
  return null;
}

// Does any descendant token hold a (bracket) link? Autolinks do not
// block an enclosing link.
function containsLink(tokens) {
  for (const t of tokens) {
    if (t.k === 'link' && !t.auto) return true;
    if (t.ch && containsLink(t.ch)) return true;
  }
  return false;
}

// Plain-text rendering of label tokens (for image alt text).
function altText(tokens) {
  let out = '';
  for (const t of tokens) {
    if (t.k === 't') out += unescapeHtml(t.s);
    else if (t.k === 'code') out += unescapeHtml(t.s);
    else if (t.k === 'br') { /* hard breaks vanish in alt text */ }
    else if (t.k === 'html') out += escapeText(t.s);
    else if (t.k === 'img') out += t.alt;
    else if (t.ch) out += altText(t.ch);
  }
  return out;
}

function unescapeHtml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Scan inline content into tokens. allowAuto=false disables extended
// autolinks (used inside link labels, where marked does not form them).
function scanInline(s, refs, allowAuto) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ k: 't', s: buf }); buf = ''; } };
  // Remove the last n chars from buf + out (used to swallow an email
  // local part that may span '_' delimiter tokens).
  const removeTail = (n) => {
    let rem = n;
    if (buf.length >= rem) { buf = buf.slice(0, buf.length - rem); return; }
    rem -= buf.length; buf = '';
    while (rem > 0 && out.length > 0) {
      const t = out[out.length - 1];
      if (t.k === 't') {
        if (t.s.length > rem) { t.s = t.s.slice(0, t.s.length - rem); rem = 0; }
        else { rem -= t.s.length; out.pop(); }
      } else if (t.k === 'delim') {
        if (t.len > rem) { t.len -= rem; rem = 0; }
        else { rem -= t.len; out.pop(); }
      } else break;
    }
  };
  const n = s.length;
  let i = 0;
  // Ranges [start, end) in s where '*'/'_' runs are literal text, not
  // emphasis delimiters: marked leaves such ranges behind after certain
  // link-label code-span quirks (see the '[' branch below).
  const suppress = [];
  const isSuppressed = (pos) => { for (let q = 0; q < suppress.length; q++) { const r = suppress[q]; if (pos >= r[0] && pos < r[1]) return true; } return false; };
  // Phantom code spans: pair backtick runs over the raw string s the way
  // the code-span branch does, ignoring link structure. A span that opens
  // inside a link label and closes after it still suppresses emphasis
  // delimiters between the link and its closing run in marked. Escaped
  // backticks (preceded by an odd run of backslashes) are literal text
  // and never open a span.
  {
    let p = 0;
    const isEsc = (pos) => { let b = 0; for (let q = pos - 1; q >= 0 && s[q] === '\\'; q--) b++; return b % 2 === 1; };
    while (p < n) {
      if (s[p] === '`' && !isEsc(p)) {
        let q = p;
        while (q < n && s[q] === '`') q++;
        const run = q - p;
        let k = q, found = -1;
        while (k < n) {
          if (s[k] === '`' && !isEsc(k)) {
            let e = k;
            while (e < n && s[e] === '`') e++;
            if (e - k === run) { found = k; break; }
            k = e;
          } else k++;
        }
        if (found >= 0) { suppress.push([p, found + run]); p = found + run; }
        else p = q;
      } else p++;
    }
  }
  while (i < n) {
    const ch = s[i];
    if (ch === '\n') {
      let sp = 0, j = i - 1;
      while (j >= 0 && s[j] === ' ') { sp++; j--; }
      if (sp >= 2) {
        if (buf.length >= sp) buf = buf.slice(0, buf.length - sp);
        flush(); out.push({ k: 'br' });
        i++;
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        continue;
      }
      buf += '\n';
      i++; continue;
    }
    if (ch === '\\') {
      if (i + 1 < n) {
        const nx = s[i + 1];
        if (nx === '\n') { flush(); out.push({ k: 'br' }); i += 2; while (i < n && (s[i] === ' ' || s[i] === '\t')) i++; continue; }
        if (isPunct(nx)) { buf += escChar(nx); i += 2; continue; }
      }
      buf += '\\'; i++; continue;
    }
    if (ch === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      const run = j - i;
      let k = j, found = -1;
      while (k < n) {
        if (s[k] === '`') {
          let e = k;
          while (e < n && s[e] === '`') e++;
          if (e - k === run) { found = k; break; }
          k = e;
        } else k++;
      }
      if (found >= 0) {
        let content = s.slice(j, found).replace(/\r\n|\r|\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && !/^ +$/.test(content)) content = content.slice(1, -1);
        flush();
        out.push({ k: 'code', s: escapeCode(content) });
        i = found + run;
        continue;
      }
      buf += '`'.repeat(run); i = j; continue;
    }
    if (ch === '*' || ch === '_') {
      let j = i;
      while (j < n && s[j] === ch) j++;
      const run = j - i;
      if (suppress.length && isSuppressed(i)) { buf += ch.repeat(run); i = j; continue; }
      const prev = i > 0 ? s[i - 1] : '';
      const next = j < n ? s[j] : '';
      const prevWs = prev === '' || isWhitespaceChar(prev);
      const nextWs = next === '' || isWhitespaceChar(next);
      const prevPunct = prev !== '' && isUnicodePunct(prev);
      const nextPunct = next !== '' && isUnicodePunct(next);
      const leftFlank = !nextWs && (!nextPunct || prevWs || prevPunct);
      const rightFlank = !prevWs && (!prevPunct || nextWs || nextPunct);
      let canOpen, canClose;
      if (ch === '*') { canOpen = leftFlank; canClose = rightFlank; }
      else { canOpen = leftFlank && (!rightFlank || prevPunct); canClose = rightFlank && (!leftFlank || nextPunct); }
      flush();
      out.push({ k: 'delim', ch, len: run, canOpen, canClose });
      i = j; continue;
    }
    if (ch === '~') {
      let j = i;
      while (j < n && s[j] === '~') j++;
      const run = j - i;
      if (run === 1 || run === 2) {
        const prev = i > 0 ? s[i - 1] : '';
        const next = j < n ? s[j] : '';
        const prevWs = prev === '' || isWhitespaceChar(prev);
        const nextWs = next === '' || isWhitespaceChar(next);
        const prevPunct = prev !== '' && isUnicodePunct(prev);
        const nextPunct = next !== '' && isUnicodePunct(next);
        const leftFlank = !nextWs && (!nextPunct || prevWs || prevPunct);
        const rightFlank = !prevWs && (!prevPunct || nextWs || nextPunct);
        flush();
        out.push({ k: 'delim', ch: '~', len: run, canOpen: leftFlank, canClose: rightFlank });
        i = j; continue;
      }
      // A run of 3+ tildes is never a strikethrough delimiter.
      buf += '~'.repeat(run); i = j; continue;
    }
    if (ch === '[' || (ch === '!' && s[i + 1] === '[')) {
      const isImg = ch === '!';
      const start = isImg ? i + 1 : i;
      const label = parseLabel(s, start);
      if (label) {
        const badSpan = labelHasBadCodeSpan(label.text);
        if (badSpan && s[label.end] === '(') {
          // A label with a "bad" code span (run >= 2 whose content holds
          // a backtick) makes the inline link/image fail, and marked
          // also renders the label's emphasis delimiters literally.
          suppress.push([start + 1, label.end - 1]);
        }
        let after = label.end;
        let href = null, title = null;
        if (s[after] === '(') {
          let q = after + 1;
          while (q < n && (s[q] === ' ' || s[q] === '\t' || s[q] === '\n')) q++;
          if (q < n && s[q] === ')') { href = ''; after = q + 1; }
          else {
            const dest = parseDest(s, q);
            if (dest) {
              q = dest.end;
              let q2 = q;
              while (q2 < n && (s[q2] === ' ' || s[q2] === '\t' || s[q2] === '\n')) q2++;
              let tt = null;
              if (q2 < n && (s[q2] === '"' || s[q2] === "'" || s[q2] === '(')) {
                const t = parseTitle(s, q2);
                if (t) { tt = t.value; q2 = t.end; }
              }
              let q3 = q2;
              while (q3 < n && (s[q3] === ' ' || s[q3] === '\t' || s[q3] === '\n')) q3++;
              if (q3 < n && s[q3] === ')') { href = dest.value; title = tt; after = q3 + 1; }
            }
          }
        }
        if (href === null && s[after] === '[') {
          const ref = parseLabel(s, after);
          if (ref) {
            // A second bracket commits to the full-reference reading:
            // if the ref has no definition (or an invalid label), do
            // not fall back to the shortcut form.
            after = -1;
            if (ref.text === '' || isValidRefLabel(ref.text)) {
              const key = normalizeLabel(ref.text === '' ? label.text : ref.text);
              const def = refs.get(key);
              if (def) { href = def.href; title = def.title; after = ref.end; }
            }
          }
        }
        if (href === null && after !== -1 && isValidRefLabel(label.text)) {
          const key = normalizeLabel(label.text);
          const def = refs.get(key);
          if (def) { href = def.href; title = def.title; }
        }
        if (href !== null && !badSpan) {
          const children = tokenizeInline(label.text, refs, false);
          if (!isImg && containsLink(children)) {
            // A link label that contains a link does not form a link.
            href = null;
          } else {
            flush();
            if (isImg) {
              out.push({ k: 'img', src: cleanUrl(href), title: title === null ? null : unescapePunct(title), alt: altText(children) });
            } else {
              out.push({ k: 'link', href: cleanUrl(href), title: title === null ? null : unescapePunct(title), ch: children });
            }
            i = after;
            continue;
          }
        }
      }
      buf += isImg ? '!' : '[';
      i += 1;
      continue;
    }
    if (ch === '<') {
      // Autolink <scheme:...>
      let done = false;
      if (i + 1 < n && isAlpha(s[i + 1])) {
        let k = i + 2;
        while (k < n && (isAlnum(s[k]) || s[k] === '+' || s[k] === '.' || s[k] === '-')) k++;
        if (k - (i + 1) >= 2 && k - (i + 1) <= 32 && k < n && s[k] === ':') {
          let e = k + 1;
          while (e < n && s[e] !== '>' && s[e] !== '<' && s[e] !== ' ' && s[e] !== '\t' && s[e] !== '\n' && s[e] !== '\r') e++;
          if (e < n && s[e] === '>' && e > k + 1) {
            const text = s.slice(i + 1, e);
            flush();
            out.push({ k: 'link', auto: true, href: cleanUrlRaw(text), title: null, ch: [{ k: 't', s: escapeText(text) }] });
            i = e + 1; done = true;
          }
        }
      }
      if (!done) {
        const em = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~_-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/.exec(s.slice(i));
        if (em) {
          flush();
          out.push({ k: 'link', auto: true, href: 'mailto:' + em[1], title: null, ch: [{ k: 't', s: escapeText(em[1]) }] });
          i += em[0].length; done = true;
        }
      }
      if (!done) {
        const tag = parseHtmlTag(s, i);
        if (tag) {
          flush();
          out.push({ k: 'html', s: tag.text });
          // marked's inLink leak: an opening <a> tag (any form except
          // the bare '<a>') suppresses extended autolinks (scheme,
          // www., email) for the rest of the document until a '</a>'
          // tag; bracket links and '<...>' autolinks are unaffected.
          const tm = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(tag.text);
          if (tm && tm[1].toLowerCase() === 'a') {
            if (tag.text.startsWith('</')) refs.inLink = false;
            // Only '<a' followed by whitespace sets it: bare '<a>'
            // and self-closing '<a/>' do not (probed).
            else if (tag.text.length > 2 && /\s/.test(tag.text[2])) refs.inLink = true;
          }
          i = tag.end; done = true;
        }
      }
      if (!done) { buf += '&lt;'; i++; }
      continue;
    }
    if (ch === '&') {
      const r = entityAt(s, i);
      if (r) { buf += r.text; i = r.next; }
      else { buf += '&amp;'; i++; }
      continue;
    }
    if (ch === '@' && allowAuto && !refs.inLink) {
      // Scan the local part backwards in the source: it may span '_'
      // delimiter tokens already flushed to out. A '*'/'_' run that is
      // a pure opener delimiter (canOpen, not canClose) is not part of
      // the local part: the email starts after it (e.g. '_a@b.co' has
      // local 'a', not '_a').
      let ls = i - 1;
      while (ls >= 0 && /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~_-]/.test(s[ls])) {
        const c = s[ls];
        if (c === '*' || c === '_') {
          let rs = ls;
          while (rs >= 0 && s[rs] === c) rs--;
          rs++;
          let pureOpener = false;
          for (let oi = out.length - 1; oi >= 0; oi--) {
            const t = out[oi];
            if (t.k === 'delim' && t.ch === c) { pureOpener = t.canOpen && !t.canClose; break; }
          }
          // Pure opener: the local part starts just after this run
          // (ls is the run's last char; the trailing ls++ does that).
          if (pureOpener) break;
          ls = rs;
        }
        ls--;
      }
      ls++;
      // If an odd run of backslashes precedes the local part, the
      // local part is cut off by an escape and no email forms.
      if (ls > 0 && s[ls - 1] === '\\') {
        let bs = 0, b = ls - 1;
        while (b >= 0 && s[b] === '\\') { bs++; b--; }
        if (bs % 2 === 1) { buf += '@'; i++; continue; }
      }
      const local = s.slice(ls, i);
      if (local) {
        // Scan the domain as dot-separated labels. A label is alnum-led
        // and may contain '_'/'-' inside, but (except the first label,
        // which may end in '-' before a dot) must end in alnum. When
        // the scan stops at a label character (a trailing '_'/'-' or a
        // bad label), backtrack: drop the last label group and retry,
        // until the following char is not a label character. Exception:
        // a trailing '_' run that is a potential emphasis closer with
        // an unmatched '_' opener earlier in this span ends the email
        // there (marked forms the link inside _..._ emphasis).
        let domEnd = -1;
        {
          let pos = i + 1;
          const ends = []; // end offset of each label (text end)
          let bad = false;
          while (pos < n && isAlnum(s[pos])) {
            let j = pos;
            while (j < n && (isAlnum(s[j]) || s[j] === '_' || s[j] === '-')) j++;
            let e = j;
            while (e > pos && (s[e - 1] === '_' || s[e - 1] === '-')) e--;
            const isFirst = ends.length === 0;
            if (j < n && s[j] === '.' && isFirst) { ends.push(j); pos = j + 1; continue; }
            if (j < n && s[j] === '.') {
              // A non-first label ending in '_'/'-' before a dot is
              // invalid: the domain ends before this label.
              if (e < j) break;
              ends.push(e); pos = j + 1;
              if (pos >= n || !isAlnum(s[pos])) break;
              continue;
            }
            // End of the label run.
            if (e === pos) { bad = true; break; }
            ends.push(e);
            break;
          }
          if (!bad && ends.length >= 2) {
            // First, the delimiter exception on the full domain: its
            // last label ends at a '_' run that can close an unmatched
            // '_' opener (email inside _..._ emphasis).
            const fullEnd = ends[ends.length - 1];
            if (fullEnd < n && s[fullEnd] === '_') {
              let r = fullEnd;
              while (r < n && s[r] === '_') r++;
              const nx = r < n ? s[r] : '';
              const prev = s[fullEnd - 1];
              const nextWs = nx === '' || isWhitespaceChar(nx);
              const nextPunct = nx !== '' && isUnicodePunct(nx);
              const prevPunct = isUnicodePunct(prev);
              const leftFlank = !nextWs && (!nextPunct || prev === '' || isWhitespaceChar(prev) || prevPunct);
              const rightFlank = prev !== '' && !isWhitespaceChar(prev) && (!prevPunct || nextWs || nextPunct);
              const canClose = rightFlank && (!leftFlank || nextPunct);
              // Is there an unmatched '_' opener earlier in this span?
              // Simulate the delimiter stack: a pure opener pushes, a
              // pure closer pops, a both delimiter closes if one is
              // open (else opens); a token that can neither open nor
              // close (intra-word '_') is ignored.
              let openUnderscore = false;
              {
                let depth = 0;
                for (let oi = 0; oi < out.length; oi++) {
                  const t = out[oi];
                  if (t.k !== 'delim' || t.ch !== '_') continue;
                  if (t.canOpen && !t.canClose) depth++;
                  else if (t.canClose && !t.canOpen) { if (depth > 0) depth--; }
                  else if (t.canOpen && t.canClose) { if (depth > 0) depth--; else depth++; }
                }
                openUnderscore = depth > 0;
              }
              if (canClose && openUnderscore) domEnd = fullEnd;
            }
            // Backtrack while the char after the chosen end is a label
            // character (the last label was cut short by '_'/'-').
            if (domEnd < 0) {
              let li = ends.length;
              while (li > 0) {
                const e = ends[li - 1];
                const nx = e < n ? s[e] : '';
                if (nx === '' || !(isAlnum(nx) || nx === '_' || nx === '-')) { domEnd = e; break; }
                li--;
              }
            }
          }
        }
        const domain = domEnd > 0 ? s.slice(i + 1, domEnd) : '';
        const dot = domain.indexOf('.');
        if (domain && dot > 0) {
          const prefix = s.slice(0, ls);
          let scheme = '';
          if (prefix.endsWith('mailto:')) scheme = 'mailto:';
          else if (prefix.endsWith('xmpp:')) scheme = 'xmpp:';
          let text = local + '@' + domain;
          let end = domEnd;
          if (scheme === 'xmpp:' && end < n && s[end] === '/') {
            let p = end + 1;
            while (p < n && s[p] !== '/' && !isWhitespaceChar(s[p]) && s[p] !== '<' && s[p] !== '>' && s[p] !== '"' && s[p] !== "'" && s[p] !== '`') p++;
            if (p > end + 1) { text += s.slice(end, p); end = p; }
          }
          if (scheme) {
            removeTail(local.length + scheme.length);
            flush();
            out.push({ k: 'link', auto: true, href: scheme + text, title: null, ch: [{ k: 't', s: escapeText(scheme + text) }] });
            i = end;
            continue;
          }
          removeTail(local.length);
          flush();
          out.push({ k: 'link', auto: true, href: 'mailto:' + text, title: null, ch: [{ k: 't', s: escapeText(text) }] });
          i = end;
          continue;
        }
      }
      buf += '@'; i++; continue;
    }
    if (allowAuto && !refs.inLink && ch === 'w' && s.startsWith('www.', i) && autolinkAllowed(s, i, out, buf)) {
      const r = scanUrl(s, i + 4);
      if (r.end > i + 4) {
        const text = trimAutolink(s.slice(i, r.end));
        if (text.length > 4) {
          flush();
          out.push({ k: 'link', auto: true, href: 'http://' + cleanUrlRaw(text), title: null, ch: [{ k: 't', s: escapeText(text) }] });
          i = i + text.length;
          continue;
        }
      }
    }
    if (allowAuto && !refs.inLink && (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F') && autolinkAllowed(s, i, out, buf, true)) {
      const low = s.slice(i, i + 8).toLowerCase();
      let scheme = null;
      if (low.startsWith('https://')) scheme = 8;
      else if (low.startsWith('http://')) scheme = 7;
      else if (low.startsWith('ftp://')) scheme = 6;
      if (scheme !== null) {
        const r = scanUrl(s, i + scheme);
        if (r.end > i + scheme) {
          const text = trimAutolink(s.slice(i, r.end));
          if (text.length > scheme) {
            flush();
            out.push({ k: 'link', auto: true, href: cleanUrlRaw(text), title: null, ch: [{ k: 't', s: escapeText(text) }] });
            i = i + text.length;
            continue;
          }
        }
      }
    }
    if (ch === '>') { buf += '&gt;'; i++; continue; }
    if (ch === '"') { buf += '&quot;'; i++; continue; }
    if (ch === "'") { buf += '&#39;'; i++; continue; }
    // Plain run: copy safe chars in bulk.
    let j = i;
    while (j < n) {
      const c = s[j];
      if (c === '\n' || c === '\\' || c === '`' || c === '*' || c === '_' || c === '~' || c === '[' || c === ']' || c === '!' || c === '<' || c === '&' || c === '@' || c === '>' || c === '"' || c === "'" || c === 'w' || c === 'h' || c === 'H' || c === 'f' || c === 'F') break;
      j++;
    }
    if (j > i) { buf += s.slice(i, j); i = j; }
    else { buf += ch; i++; }
  }
  flush();
  return out;
}

// Resolve emphasis / strong / strikethrough delimiters (CommonMark
// delimiter-stack algorithm, with the rule of three). A closer that can
// also open ("both" delimiter), when consumed, raises a barrier: the
// immediately following closer may not use an opener before the node just
// created when that opener is at least as long as the closer (so a lone
// '*' may still close a '**' opener). The barrier is lifted once that
// closer is processed.
function resolveDelimiters(tokens) {
  // barrier: {node, ch, closerLen, openerCanClose} of the most recent
  // match whose closer could also open. It only bars openers of the
  // same character (a '~~' match must not bar a '_' opener).
  let barrier = null;
  while (true) {
    let matched = false;
    for (let ci = 0; ci < tokens.length; ci++) {
      const closer = tokens[ci];
      if (closer.k !== 'delim' || closer.len === 0 || !closer.canClose) continue;
      const barrierIdx = (barrier && barrier.ch === closer.ch) ? tokens.indexOf(barrier.node) : -1;
      let found = false;
      for (let oi = ci - 1; oi >= 0; oi--) {
        const opener = tokens[oi];
        if (opener.k !== 'delim' || opener.len === 0 || opener.ch !== closer.ch || !opener.canOpen) continue;
        // Blocked by the barrier (see comment above): an opener before
        // the barrier node is barred when it is longer than this closer
        // or shorter than the barrier-creating closer's run.
        if (barrierIdx >= 0 && oi < barrierIdx && !barrier.openerCanClose &&
            (opener.len > closer.len || opener.len < barrier.closerLen)) continue;
        // Strikethrough delimiters only match when the runs have the
        // same length (1 with 1, 2 with 2).
        if (closer.ch === '~' && opener.len !== closer.len) continue;
        // Rule of three: if either delimiter can both open and close,
        // the sum of the run lengths must not be a multiple of 3 unless
        // both lengths are multiples of 3.
        if ((opener.canOpen && opener.canClose) || (closer.canOpen && closer.canClose)) {
          if ((opener.len + closer.len) % 3 === 0 && !(opener.len % 3 === 0 && closer.len % 3 === 0)) continue;
        }
        const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
        const kind = closer.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
        const children = tokens.slice(oi + 1, ci);
        const node = { k: kind, ch: children };
        const closerBoth = closer.canOpen && closer.canClose;
        tokens.splice(oi, ci - oi + 1, node);
        opener.len -= use; closer.len -= use;
        if (opener.len > 0) tokens.splice(oi, 0, opener);
        const nodeIdx = oi + (opener.len > 0 ? 1 : 0);
        if (closer.len > 0) tokens.splice(nodeIdx + 1, 0, closer);
        barrier = closerBoth ? { node, ch: closer.ch, closerLen: closer.len + use, openerCanClose: opener.canOpen && opener.canClose } : null;
        matched = true;
        found = true;
        break;
      }
      if (matched) break;
      // A closer that found no opener does NOT clear the barrier:
      // the barrier must still bar pre-node openers for later closers
      // (doc-11: the '*' after 'parse' fails, yet the final '**' must
      // still skip the '*' opener and use the '**' opener).
    }
    if (!matched) break;
  }
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].k === 'delim') tokens[i] = { k: 't', s: tokens[i].ch.repeat(tokens[i].len) };
  }
  return tokens;
}

function renderTokens(tokens) {
  let out = '';
  for (const t of tokens) {
    if (t.k === 't') out += t.s;
    else if (t.k === 'code') out += '<code>' + t.s + '</code>';
    else if (t.k === 'br') out += '<br>';
    else if (t.k === 'html') out += t.s;
    else if (t.k === 'link') {
      out += '<a href="' + escapeAttr(t.href) + '"';
      if (t.title !== null && t.title !== undefined) out += ' title="' + escapeAttr(t.title) + '"';
      out += '>' + renderTokens(t.ch) + '</a>';
    } else if (t.k === 'img') {
      out += '<img src="' + escapeAttr(t.src) + '" alt="' + escapeAttr(t.alt) + '"';
      if (t.title !== null && t.title !== undefined) out += ' title="' + escapeAttr(t.title) + '"';
      out += '>';
    } else if (t.k === 'em') out += '<em>' + renderTokens(t.ch) + '</em>';
    else if (t.k === 'strong') out += '<strong>' + renderTokens(t.ch) + '</strong>';
    else if (t.k === 'del') out += '<del>' + renderTokens(t.ch) + '</del>';
    else if (t.k === 'delim') out += t.ch.repeat(t.len);
  }
  return out;
}

function tokenizeInline(s, refs, allowAuto) {
  return resolveDelimiters(scanInline(s, refs, allowAuto));
}

function parseInline(s, refs) {
  return renderTokens(tokenizeInline(s, refs, true));
}

// ---------- block rendering ----------
// Last line of a block (containers do not maintain el; derive it from
// their last descendant, or their own el if a trailing blank line
// inside the container pushed it further).
function blockEnd(b) {
  let cur = b;
  let end = b.el;
  while (Array.isArray(cur.ch) && cur.ch.length) {
    cur = cur.ch[cur.ch.length - 1];
    if (cur.el !== undefined && (end === undefined || cur.el > end)) end = cur.el;
  }
  return end === undefined ? b.el : end;
}

function listIsLoose(list, blankSet) {
  const items = list.ch;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    for (let j = 0; j + 1 < item.ch.length; j++) {
      const a = item.ch[j], b = item.ch[j + 1];
      for (const bl of blankSet) {
        if (bl > blockEnd(a) && bl < b.sl) return true;
      }
    }
    if (i + 1 < items.length) {
      const a = items[i], b = items[i + 1];
      for (const bl of blankSet) {
        if (bl > blockEnd(a) && bl < b.sl) return true;
      }
    }
  }
  return false;
}

function renderBlock(b, refs, blankSet, emptySet) {
  if (b.dead) return '';
  switch (b.t) {
    case 'doc': {
      let out = '';
      emptySet = emptySet || b.emptySet || new Set();
      for (let ci = 0; ci < b.ch.length; ci++) {
        const c = b.ch[ci];
        out += renderBlock(c, refs, blankSet, emptySet);
        // An HTML block takes a trailing newline exactly when the line
        // after its last line is not a terminator for it, or when its
        // last line is the last input line and the input ends with a
        // newline. Types 1-5 end at a terminator line, so only a truly
        // empty line suppresses the newline; type 6 ends at a blank
        // line, so a whitespace-only line suppresses it too.
        if (c.t === 'html') {
          const next = c.el + 1;
          const term = c.htype === 6 ? blankSet : emptySet;
          const trail = (next < b.totalLines && !term.has(next)) || (next === b.totalLines && b.endsWithNewline);
          if (trail) out += '\n';
        }
      }
      return out;
    }
    case 'bq': {
      let out = '<blockquote>\n';
      for (let ci = 0; ci < b.ch.length; ci++) {
        const c = b.ch[ci];
        out += renderBlock(c, refs, blankSet, emptySet);
        // An HTML block takes a trailing newline when another block
        // follows it inside the quote, unless the line after it is a
        // terminator for its type (same rule as at document level).
        if (c.t === 'html' && b.ch.slice(ci + 1).some(x => !x.dead)) {
          const term = c.htype === 6 ? blankSet : emptySet;
          if (!term.has(c.el + 1)) out += '\n';
        }
      }
      return out + '</blockquote>\n';
    }
    case 'list': {
      const loose = listIsLoose(b, blankSet);
      let out;
      if (b.bullet) out = '<ul>\n';
      else out = b.start !== 1 ? '<ol start="' + b.start + '">\n' : '<ol>\n';
      for (const item of b.ch) out += renderItem(item, refs, blankSet, loose, emptySet);
      return out + (b.bullet ? '</ul>\n' : '</ol>\n');
    }
    case 'heading':
      return '<h' + b.level + '>' + parseInline(b.text, refs) + '</h' + b.level + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'fence': {
      let lang = '';
      if (b.info) {
        const w = b.info.split(/[ \t]/)[0];
        if (w) lang = ' class="language-' + escapeAttr(unescapePunct(w)) + '"';
      }
      // A fenced block drops one trailing blank content line.
      const lines = b.lines.slice();
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      return '<pre><code' + lang + '>' + escapeCode(lines.join('\n') + (lines.length ? '\n' : '')) + '</code></pre>\n';
    }
    case 'code':
      return '<pre><code>' + escapeCode(b.lines.join('\n') + (b.lines.length ? '\n' : '')) + '</code></pre>\n';
    case 'html':
      return b.lines.join('\n');
    case 'para':
      return '<p>' + parseInline(b.text, refs) + '</p>\n';
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < b.ncols; i++) {
        const cell = i < b.header.length ? b.header[i] : '';
        const a = b.aligns[i];
        out += a ? '<th align="' + a + '">' + parseInline(cell, refs) + '</th>\n' : '<th>' + parseInline(cell, refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let i = 0; i < b.ncols; i++) {
            const cell = i < row.length ? row[i] : '';
            const a = b.aligns[i];
            out += a ? '<td align="' + a + '">' + parseInline(cell, refs) + '</td>\n' : '<td>' + parseInline(cell, refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    default:
      return '';
  }
}

function renderItem(item, refs, blankSet, loose, emptySet) {
  let out = '<li>';
  const ch = item.ch;
  for (let i = 0; i < ch.length; i++) {
    const c = ch[i];
    if (c.t === 'para' && !c.dead) {
      if (loose) {
        out += '<p>' + renderParaText(c, refs, i === 0) + '</p>\n';
      } else {
        out += renderParaText(c, refs, i === 0);
      }
    } else if (!c.dead) {
      out += renderBlock(c, refs, blankSet, emptySet);
      // An HTML block takes a trailing newline when another block
      // follows it inside the item, unless the line after it is a
      // terminator for its type (same rule as at document level).
      if (c.t === 'html' && ch.slice(i + 1).some(x => !x.dead)) {
        const term = c.htype === 6 ? blankSet : emptySet;
        if (!term.has(c.el + 1)) out += '\n';
      }
    }
  }
  return out + '</li>\n';
}

// Render a paragraph's inline text, handling a leading task-list checkbox
// when this paragraph is the first child of a list item.
function renderParaText(para, refs, first) {
  let text = para.text;
  if (first) {
    const m = /^\[([ xX])\][ \t]+(?=\S)/.exec(text);
    if (m) {
      const checked = m[1] === 'x' || m[1] === 'X';
      const rest = text.slice(m[0].length);
      return (checked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ') + parseInline(rest, refs);
    }
  }
  return parseInline(text, refs);
}

// ---------- entry point ----------
export function parse(markdown) {
  const refs = new Map();
  const root = parseBlocks(markdown, refs);
  const blankSet = root.blankSet || new Set();
  return renderBlock(root, refs, blankSet);
}

// ---------- driver ----------
// Outside a container MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in
// for /input and /output.
const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const input = JSON.parse(readFileSync(INPUT_DIR + '/cases.json', 'utf8'));
const results = new Array(input.length);
for (let i = 0; i < input.length; i++) results[i] = parse(input[i].markdown);
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(OUTPUT_DIR + '/html.json', JSON.stringify(results));
