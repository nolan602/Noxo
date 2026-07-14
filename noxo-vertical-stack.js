/**
 * NOXO – Free Drag Layout  v8
 *
 * Fix critique v8 :
 *   restoreLayout stocke les références panels AVANT de les retirer du DOM,
 *   puis les réinsère depuis la Map — plus de panels "perdus dans le vide".
 */
(function () {
  'use strict';

  var HOLD_MS     = 180;
  var SNAP_RATIO  = 0.38;
  var ANIM_MS     = 240;
  var GAP_PX      = 8;
  var STORAGE_KEY = 'noxo_v8_layout';
  var DRAG_MIN_PX = 6;

  var holdTimer = null, dragging = false, dragPanel = null;
  var placeholder = null, dropTarget = null, dropZone = null, overlayEl = null;
  var startX, startY, offX, offY, hasMoved;

  function main() { return document.querySelector('main.main-content'); }
  function isInCol(p) { return p.parentElement && p.parentElement.classList.contains('nxcol-slot'); }
  function isPanelVisible(p) {
    return p && p.style.display !== 'none' && p.dataset.hidden !== '1';
  }

  function rescueHiddenPanels(col, m) {
    Array.from(col.querySelectorAll('[data-panel]')).forEach(function(p) {
      if (!isPanelVisible(p)) m.appendChild(p);
    });
  }

  /* ══════════════════════════════════════════
     STYLES — on touche UNIQUEMENT ces props
  ══════════════════════════════════════════ */
  var LAYOUT_PROPS = [
    'position','inset','top','left','right','bottom',
    'width','height','flex','minWidth','margin','marginTop','marginLeft','marginRight',
    'borderRadius','opacity','pointerEvents','boxShadow','zIndex','transition','transform'
  ];

  function clearLayoutProps(panel) {
    LAYOUT_PROPS.forEach(function(p){ panel.style[p] = ''; });
  }

  function applyStandaloneStyle(panel) {
    clearLayoutProps(panel);
    panel.style.position     = 'relative';
    panel.style.flex         = '1';
    panel.style.minWidth     = panel.id === 'panel-produits' ? '320px' : '0';
    panel.style.height       = 'calc(100% - 0.5cm)';
    panel.style.marginTop    = '0.5cm';
    panel.style.marginLeft   = '0.5cm';
    panel.style.borderRadius = '18px 18px 0 0';
  }

  function applySlotStyle(panel) {
    clearLayoutProps(panel);
    panel.style.position = 'absolute';
    panel.style.inset    = '0';
    panel.style.width    = '100%';
    panel.style.height   = '100%';
    panel.style.margin   = '0';
  }

  /* ══════════════════════════════════════════
     COLONNES
  ══════════════════════════════════════════ */

  function makeSlot(pos) {
    var s = document.createElement('div');
    s.className = 'nxcol-slot';
    s.dataset.slotPos = pos;
    return s;
  }

  function detachFromCol(panel) {
    var slot    = panel.parentElement;
    var col     = slot.parentElement;
    var m       = col.parentElement;
    var colNext = col.nextSibling;
    panel.remove();
    var remaining = col.querySelector('[data-panel]');
    if (remaining) {
      Array.from(col.querySelectorAll('[data-panel]')).forEach(function(p) {
        if (p !== remaining && !isPanelVisible(p)) m.appendChild(p);
      });
      if (isPanelVisible(remaining)) {
        applyStandaloneStyle(remaining);
        m.insertBefore(remaining, colNext);
      } else {
        m.appendChild(remaining);
      }
    }
    rescueHiddenPanels(col, m);
    col.remove();
    return colNext;
  }

  function cleanupColumns() {
    var m = main();
    if (!m) return;
    Array.from(m.querySelectorAll('.nxcol')).forEach(function(col) {
      var panels = Array.from(col.querySelectorAll('[data-panel]'));
      var visible = panels.filter(isPanelVisible);
      if (visible.length === 0) {
        rescueHiddenPanels(col, m);
        col.remove();
      } else if (visible.length === 1) {
        var ref = col.nextSibling;
        var p = visible[0];
        panels.filter(function(x) { return x !== p; }).forEach(function(h) { m.appendChild(h); });
        applyStandaloneStyle(p);
        m.insertBefore(p, ref);
        col.remove();
      }
    });
  }

  function applyWidgetVisibility(state, allWidgets) {
    var m = main();
    if (!m || !allWidgets) return;

    allWidgets.forEach(function(t) {
      var panel = document.getElementById('panel-' + t);
      if (!panel) return;
      if (state[t] === '1') {
        panel.dataset.hidden = '0';
        panel.style.display = '';
      } else {
        panel.style.display = 'none';
        panel.dataset.hidden = '1';
      }
    });

    cleanupColumns();

    allWidgets.forEach(function(t) {
      if (state[t] !== '1') return;
      var panel = document.getElementById('panel-' + t);
      if (!panel || panel.parentElement) {
        if (panel && isPanelVisible(panel)) {
          if (isInCol(panel)) applySlotStyle(panel);
          else if (panel.parentElement === m) applyStandaloneStyle(panel);
        }
        return;
      }
      applyStandaloneStyle(panel);
      m.appendChild(panel);
    });

    cleanupColumns();
    saveLayout();
  }

  function stackPanels(incoming, target, zone) {
    var m = main();
    if (isInCol(target)) {
      applyStandaloneStyle(incoming);
      m.insertBefore(incoming, placeholder || null);
      return;
    }
    var col = document.createElement('div');
    col.className = 'nxcol';
    var slotTop = makeSlot('top');
    var slotBot = makeSlot('bottom');
    col.appendChild(slotTop);
    col.appendChild(slotBot);
    m.insertBefore(col, target);
    target.remove();
    if (zone === 'top') { slotTop.appendChild(incoming); slotBot.appendChild(target); }
    else                { slotTop.appendChild(target);   slotBot.appendChild(incoming); }
    applySlotStyle(incoming);
    applySlotStyle(target);
    slideIn(incoming, zone === 'top' ? 'from-top' : 'from-bottom');
  }

  function slideIn(panel, dir) {
    var from = dir === 'from-top' ? 'translateY(-60%)' : 'translateY(60%)';
    panel.style.transition = 'none';
    panel.style.transform  = from;
    panel.style.opacity    = '0';
    requestAnimationFrame(function(){ requestAnimationFrame(function(){
      panel.style.transition = 'transform ' + ANIM_MS + 'ms cubic-bezier(.4,0,.2,1), opacity ' + ANIM_MS + 'ms ease';
      panel.style.transform  = '';
      panel.style.opacity    = '';
      setTimeout(function(){
        panel.style.transition = '';
        panel.style.transform  = '';
        panel.style.opacity    = '';
      }, ANIM_MS + 40);
    }); });
  }

  /* ══════════════════════════════════════════
     OVERLAY
  ══════════════════════════════════════════ */

  function showOverlay(targetPanel, zone) {
    if (isInCol(targetPanel)) { hideOverlay(); return; }
    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.style.cssText = [
        'position:fixed','pointer-events:none','z-index:9800',
        'background:rgba(77,217,255,.13)','border:2px solid rgba(77,217,255,.7)',
        'border-radius:10px','display:flex','align-items:center','justify-content:center',
        'font-size:11px','font-weight:700','font-family:Segoe UI,sans-serif',
        'color:rgba(77,217,255,.95)','letter-spacing:.07em','text-transform:uppercase',
      ].join(';');
      document.body.appendChild(overlayEl);
    }
    var r = targetPanel.getBoundingClientRect();
    var h = r.height / 2;
    overlayEl.style.left   = r.left + 'px';
    overlayEl.style.top    = (zone === 'top' ? r.top : r.top + h) + 'px';
    overlayEl.style.width  = r.width + 'px';
    overlayEl.style.height = h + 'px';
    overlayEl.textContent  = zone === 'top' ? '▲ Au-dessus' : '▼ En-dessous';
  }

  function hideOverlay() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  }

  /* ══════════════════════════════════════════
     PLACEHOLDER
  ══════════════════════════════════════════ */

  function createPlaceholder() {
    var ph = document.createElement('div');
    ph.className = 'noxo-ph';
    ph.style.cssText = [
      'flex:1','min-width:0',
      'height:calc(100% - 0.5cm)','margin-top:0.5cm','margin-left:0.5cm',
      'border-radius:18px 18px 0 0',
      'background:rgba(77,217,255,.04)',
      'border:2px dashed rgba(77,217,255,.3)',
      'box-sizing:border-box','pointer-events:none','flex-shrink:0',
    ].join(';');
    return ph;
  }

  function movePlaceholder(ex) {
    if (!placeholder) return;
    var m = main();
    var kids = Array.from(m.children).filter(function(c){ return c !== placeholder; });
    var before = null;
    for (var i = 0; i < kids.length; i++) {
      var r = kids[i].getBoundingClientRect();
      if (ex < r.left + r.width / 2) { before = kids[i]; break; }
    }
    m.insertBefore(placeholder, before || null);
  }

  /* ══════════════════════════════════════════
     HIT TEST
  ══════════════════════════════════════════ */

  function hitTest(ex, ey) {
    dropTarget = null; dropZone = null;
    var panels = Array.from(document.querySelectorAll('[data-panel]'))
      .filter(function(p){ return p !== dragPanel && isPanelVisible(p); });
    for (var i = 0; i < panels.length; i++) {
      var p = panels[i];
      var r = p.getBoundingClientRect();
      if (ex < r.left || ex > r.right || ey < r.top || ey > r.bottom) continue;
      if (isInCol(p)) break;
      var rel = (ey - r.top) / r.height;
      if (rel < SNAP_RATIO)          { dropTarget = p; dropZone = 'top';    }
      else if (rel > 1 - SNAP_RATIO) { dropTarget = p; dropZone = 'bottom'; }
      break;
    }
    if (dropTarget) showOverlay(dropTarget, dropZone);
    else { hideOverlay(); movePlaceholder(ex); }
  }

  /* ══════════════════════════════════════════
     MOUSEDOWN
  ══════════════════════════════════════════ */

  function onMouseDown(e) {
    if (e.button !== 0 || dragging) return;
    var handle = e.target.closest('.panel-drag-handle');
    if (!handle) return;
    var panel = handle.closest('[data-panel]');
    if (!panel) return;
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX; startY = e.clientY; hasMoved = false;
    var r = panel.getBoundingClientRect();
    offX = e.clientX - r.left;
    offY = e.clientY - r.top;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    var captured = panel;
    function onEarlyMove(ev) {
      if (Math.abs(ev.clientX - startX) > DRAG_MIN_PX || Math.abs(ev.clientY - startY) > DRAG_MIN_PX) {
        hasMoved = true;
        clearTimeout(holdTimer);
        document.removeEventListener('mousemove', onEarlyMove);
        document.removeEventListener('mouseup',   onEarlyCancel);
        startDrag(captured, ev);
      }
    }
    function onEarlyCancel() {
      clearTimeout(holdTimer);
      document.removeEventListener('mousemove', onEarlyMove);
      document.removeEventListener('mouseup',   onEarlyCancel);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    holdTimer = setTimeout(function() {
      document.removeEventListener('mousemove', onEarlyMove);
      document.removeEventListener('mouseup',   onEarlyCancel);
      if (!hasMoved) startDrag(captured, { clientX: startX, clientY: startY });
    }, HOLD_MS);
    document.addEventListener('mousemove', onEarlyMove);
    document.addEventListener('mouseup',   onEarlyCancel);
  }

  /* ══════════════════════════════════════════
     DRAG
  ══════════════════════════════════════════ */

  function startDrag(panel, e) {
    dragging  = true;
    dragPanel = panel;
    var m = main();
    var r = panel.getBoundingClientRect();
    var pw = r.width, ph = r.height;
    if (isInCol(panel)) {
      var insertRef = detachFromCol(panel);
      placeholder = createPlaceholder();
      m.insertBefore(placeholder, insertRef || null);
    } else {
      placeholder = createPlaceholder();
      m.insertBefore(placeholder, panel);
      panel.remove();
    }
    document.body.appendChild(panel);
    clearLayoutProps(panel);
    panel.style.position      = 'fixed';
    panel.style.left          = (e.clientX - offX) + 'px';
    panel.style.top           = (e.clientY - offY) + 'px';
    panel.style.width         = pw + 'px';
    panel.style.height        = ph + 'px';
    panel.style.margin        = '0';
    panel.style.borderRadius  = '14px';
    panel.style.zIndex        = '9500';
    panel.style.opacity       = '0.9';
    panel.style.pointerEvents = 'none';
    panel.style.boxShadow     = '0 32px 80px rgba(0,0,0,.9),0 0 0 2px #4dd9ff,0 0 60px rgba(77,217,255,.15)';
    panel.style.transition    = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);
  }

  function onMouseMove(e) {
    if (!dragging) return;
    dragPanel.style.left = (e.clientX - offX) + 'px';
    dragPanel.style.top  = (e.clientY - offY) + 'px';
    hitTest(e.clientX, e.clientY);
  }

  function onMouseUp() {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup',   onMouseUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    hideOverlay();
    dragPanel.remove();
    var m = main();
    if (dropTarget && dropZone) {
      if (placeholder) { placeholder.remove(); placeholder = null; }
      applyStandaloneStyle(dragPanel);
      stackPanels(dragPanel, dropTarget, dropZone);
    } else {
      applyStandaloneStyle(dragPanel);
      m.insertBefore(dragPanel, placeholder || null);
      if (placeholder) { placeholder.remove(); placeholder = null; }
    }
    dragPanel = null; dropTarget = null; dropZone = null;
    saveLayout();
  }

  /* ══════════════════════════════════════════
     PERSISTANCE — clé unique, robuste
  ══════════════════════════════════════════ */

  function saveLayout() {
    var m = main();
    if (!m) return;
    cleanupColumns();
    var layout = [];
    Array.from(m.children).forEach(function(child) {
      if (child.dataset && child.dataset.panel) {
        if (!isPanelVisible(child)) return;
        layout.push({ type: 'solo', id: child.dataset.panel });
      } else if (child.classList && child.classList.contains('nxcol')) {
        var ids = [];
        child.querySelectorAll('.nxcol-slot').forEach(function(s) {
          var p = s.querySelector('[data-panel]');
          if (p && isPanelVisible(p)) ids.push(p.dataset.panel);
        });
        if (ids.length >= 2) layout.push({ type: 'col', ids: ids });
        else if (ids.length === 1) layout.push({ type: 'solo', id: ids[0] });
      }
    });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); } catch(e) {}
  }

  function restoreLayout() {
    var saved;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch(_){ return; }
    if (!Array.isArray(saved) || !saved.length) return;

    var m = main();
    if (!m) return;

    /* ── ÉTAPE 1 : construire une Map id → élément DOM AVANT de toucher au DOM ── */
    var panelMap = {};
    Array.from(document.querySelectorAll('[data-panel]')).forEach(function(p) {
      panelMap[p.dataset.panel] = p;
    });

    /* ── ÉTAPE 2 : retirer TOUS les panels de main (ordre HTML) ── */
    Object.keys(panelMap).forEach(function(id) {
      var p = panelMap[id];
      if (p.parentElement) p.remove();
    });

    /* ── ÉTAPE 3 : réinsérer dans l'ordre sauvegardé depuis la Map ── */
    saved.forEach(function(entry) {

      if (entry.type === 'solo') {
        var p = panelMap[entry.id];
        if (!p) return;
        if (p.dataset.hidden === '1' || p.style.display === 'none') {
          /* Panel masqué par le système widgets → remettre dans main mais caché */
          p.style.display = 'none';
          m.appendChild(p);
          return;
        }
        applyStandaloneStyle(p);
        m.appendChild(p);

      } else if (entry.type === 'col') {
        var panels = (entry.ids || [])
          .map(function(id){ return panelMap[id] || null; })
          .filter(function(p){ return p && p.style.display !== 'none' && p.dataset.hidden !== '1'; });

        if (panels.length < 2) {
          panels.forEach(function(p){ applyStandaloneStyle(p); m.appendChild(p); });
          return;
        }

        var col = document.createElement('div');
        col.className = 'nxcol';
        panels.forEach(function(p, i) {
          var slot = makeSlot(i === 0 ? 'top' : 'bottom');
          applySlotStyle(p);
          slot.appendChild(p);
          col.appendChild(slot);
        });
        m.appendChild(col);
      }
    });

    /* ── ÉTAPE 4 : panels absents du layout sauvegardé → remettre à la fin ── */
    Object.keys(panelMap).forEach(function(id) {
      var p = panelMap[id];
      if (!p.parentElement) {
        /* Ce panel n'était pas dans le layout sauvegardé (ex: widget ajouté après) */
        if (p.style.display !== 'none' && p.dataset.hidden !== '1') applyStandaloneStyle(p);
        m.appendChild(p);
      }
    });
    cleanupColumns();
    saveLayout();
  }

  /* ══════════════════════════════════════════
     CSS
  ══════════════════════════════════════════ */

  function injectCSS() {
    var s = document.createElement('style');
    s.textContent = [
      '.panel-drag-handle { cursor: grab; user-select: none; -webkit-user-select: none; }',
      '.panel-drag-handle:active { cursor: grabbing; }',
      '.nxcol { display:flex; flex-direction:column; flex:1; min-width:0;',
      '         height:calc(100% - 0.5cm); margin-top:0.5cm; margin-left:0.5cm;',
      '         gap:' + GAP_PX + 'px; }',
      '.nxcol-slot { flex:1; min-height:0; position:relative; overflow:hidden;',
      '              border-radius:18px 18px 0 0; }',
      '.noxo-ph { pointer-events:none; }',
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ══════════════════════════════════════════
     INIT
  ══════════════════════════════════════════ */

  function init() {
    injectCSS();
    window.NoxoLayout = {
      saveLayout: saveLayout,
      cleanupColumns: cleanupColumns,
      applyStandaloneStyle: applyStandaloneStyle,
      applySlotStyle: applySlotStyle,
      applyWidgetVisibility: applyWidgetVisibility
    };
    restoreLayout();
    window.addEventListener('beforeunload', saveLayout);
    window.addEventListener('pagehide',     saveLayout);
    document.addEventListener('mousedown',  onMouseDown);
    console.log('[NOXO v8] ✓ key=' + STORAGE_KEY);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
