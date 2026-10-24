/* DSH Markdown — a small, safe, streaming-friendly renderer.
   No dependencies. Escapes all HTML; supports headings, lists, fenced code,
   inline code, bold/italic/strike, links, blockquotes, tables and rules.
   Exposes window.DSHRenderMarkdown(text) -> html string. */
(function (global) {
  'use strict';

  var ALLOWED_LINK = /^(https?:\/\/|mailto:)/i;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeUrl(url) {
    var u = String(url || '').trim();
    if (!u) return '';
    if (u.charAt(0) === '<' && u.charAt(u.length - 1) === '>') u = u.slice(1, -1);
    if (!ALLOWED_LINK.test(u)) return '';
    return escapeHtml(u);
  }

  var CODE_TOKEN = '\u0001';

  function renderInline(text) {
    var codes = [];
    // Pull out inline code spans first so other markers cannot touch them.
    var withTokens = text.replace(/(`+)([\s\S]*?)\1/g, function (_, ticks, body) {
      codes.push('<code>' + escapeHtml(body) + '</code>');
      return CODE_TOKEN + (codes.length - 1) + CODE_TOKEN;
    });

    var out = escapeHtml(withTokens);

    // Links: [label](url)
    out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
      var safe = sanitizeUrl(url.replace(/&amp;/g, '&'));
      if (!safe) return label;
      return '<a href="' + safe + '" target="_blank" rel="noreferrer noopener">' + label + '</a>';
    });

    // Bare URLs (not already inside a tag/attribute)
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, function (m, lead, url) {
      return lead + '<a href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer noopener">' + url + '</a>';
    });

    // Bold, italic, strike (bold before italic)
    out = out
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    // Restore inline code tokens.
    out = out.replace(/\u0001(\d+)\u0001/g, function (m, i) {
      return codes[Number(i)] || '';
    });
    return out;
  }

  function isTableSeparator(line) {
    return /^\s*\|?\s*:?\s*-{2,}\s*:?\s*(\|\s*:?\s*-{2,}\s*:?\s*)+\|?\s*$/.test(line);
  }
  function splitRow(line) {
    var s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    return s.split('|').map(function (c) { return c.trim(); });
  }

  function render(src) {
    if (src === undefined || src === null) return '';
    var lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    var html = [];
    var i = 0;

    function isFence(line) { return /^\s*(```|~~~)/.test(line); }
    function fenceInfo(line) {
      var m = /^\s*(```|~~~)\s*([^`\s]*)\s*$/.exec(line);
      return m ? m[2] : '';
    }
    function startsBlock(line) {
      return (
        /^\s*$/.test(line) ||
        /^\s*#{1,6}\s+/.test(line) ||
        /^\s*>/.test(line) ||
        /^\s*([-*+]|\d+\.)\s+/.test(line) ||
        /^\s*(---+|\*\*\*+|___+)\s*$/.test(line) ||
        isFence(line) ||
        (/\|/.test(line) && false)
      );
    }

    while (i < lines.length) {
      var line = lines[i];

      // blank
      if (/^\s*$/.test(line)) { i++; continue; }

      // fenced code
      if (isFence(line)) {
        var lang = fenceInfo(line);
        i++;
        var buf = [];
        while (i < lines.length && !isFence(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // closing fence
        var cls = lang ? ' class="lang-' + escapeHtml(lang) + '"' : '';
        html.push('<pre><code' + cls + '>' + escapeHtml(buf.join('\n')) + '</code></pre>');
        continue;
      }

      // heading
      var h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        var level = Math.min(h[1].length, 4);
        html.push('<h' + level + '>' + renderInline(h[2].replace(/\s+#+\s*$/, '')) + '</h' + level + '>');
        i++;
        continue;
      }

      // horizontal rule
      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
        html.push('<hr>');
        i++;
        continue;
      }

      // blockquote
      if (/^\s*>/.test(line)) {
        var quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        html.push('<blockquote>' + renderInline(quote.join('\n')).replace(/\n/g, '<br>') + '</blockquote>');
        continue;
      }

      // table
      if (i + 1 < lines.length && lines[i].indexOf('|') !== -1 && isTableSeparator(lines[i + 1])) {
        var head = splitRow(line);
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf('|') !== -1 && !/^\s*$/.test(lines[i])) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        var t = '<table><thead><tr>' + head.map(function (c) { return '<th>' + renderInline(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
        rows.forEach(function (r) {
          t += '<tr>' + head.map(function (_, ci) {
            return '<td>' + renderInline(r[ci] === undefined ? '' : r[ci]) + '</td>';
          }).join('') + '</tr>';
        });
        html.push(t + '</tbody></table>');
        continue;
      }

      // list (supports one level of nesting via indentation)
      var lm = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
      if (lm) {
        var ordered = /\d+\./.test(lm[2]);
        var baseIndent = lm[1].length;
        var tag = ordered ? 'ol' : 'ul';
        var items = [];
        while (i < lines.length) {
          var m2 = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
          if (!m2) break;
          var ind = m2[1].length;
          if (ind < baseIndent) break;
          if (ind > baseIndent + 1) {
            // nested item: attach as a sub-list entry to the previous item
            if (items.length) {
              items[items.length - 1].sub.push({ ordered: /\d+\./.test(m2[2]), text: m2[3] });
            }
            i++;
            continue;
          }
          items.push({ ordered: /\d+\./.test(m2[2]), text: m2[3], sub: [] });
          i++;
        }
        var listHtml = '<' + tag + '>';
        items.forEach(function (it) {
          if (it.sub.length) {
            var subTag = it.sub[0].ordered ? 'ol' : 'ul';
            listHtml += '<li>' + renderInline(it.text) + '<' + subTag + '>' + it.sub.map(function (s) {
              return '<li>' + renderInline(s.text) + '</li>';
            }).join('') + '</' + subTag + '></li>';
          } else {
            listHtml += '<li>' + renderInline(it.text) + '</li>';
          }
        });
        listHtml += '</' + tag + '>';
        html.push(listHtml);
        continue;
      }

      // paragraph: gather until a block boundary
      var para = [line];
      i++;
      while (i < lines.length && !startsBlock(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      html.push('<p>' + renderInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
    }

    return html.join('');
  }

  global.DSHRenderMarkdown = render;
  global.DSHEscapeHtml = escapeHtml;
})(typeof window !== 'undefined' ? window : globalThis);
