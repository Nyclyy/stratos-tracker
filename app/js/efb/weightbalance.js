/* EFB · Weight & Balance.
 *
 * Two honest modes:
 *
 *   Plan — the imported SimBrief load sheet as filed: OEW, payload, ZFW, TOW,
 *   LW, each against its certified limit, with the CG only when the plan states
 *   one.
 *
 *   Load sheet — the same arithmetic from values the pilot enters, so a change in
 *   passengers, cargo or fuel can be checked before it happens. Limits come from
 *   the plan or from the pilot's documentation.
 *
 * Stratos has no station/arm table for these types, so it never computes a CG.
 * It shows the plan's CG or an entered one, and says plainly that the envelope
 * check needs a minimum and maximum %MAC.
 */

import { esc, fmtNum, currentPlan } from './common.js';
import {
  computeLoadSheet, limitsFromOfp, plannedLandingWeight,
} from '../lib/weightbalance.js';
import { convertWeight, fmtWeight } from '../lib/flightsummary.js';
import { aircraftLabel } from '../data/efb-aircraft.js';

function bar(check) {
  if (!check.checked) {
    return `<div class="e-bar" data-state="none"><b style="width:0"></b></div><div class="e-small e-faint">No limit available to check against.</div>`;
  }
  const state = check.over ? 'bad' : check.percent > 0.96 ? 'warn' : 'good';
  return `<div class="e-bar" data-state="${state}"><b style="width:${Math.min(100, check.percent * 100).toFixed(1)}%"></b></div>
    <div class="e-small ${check.over ? '' : 'e-faint'}" style="${check.over ? 'color:var(--efb-bad)' : ''}">${fmtNum(check.value)} of ${fmtNum(check.limit)} · ${check.over ? `${fmtNum(check.value - check.limit)} over` : `${fmtNum(check.margin)} margin`}</div>`;
}

export async function mount(root, ctx) {
  const plan = currentPlan();
  const ofp = plan && plan.ofp;
  const limitsOfp = limitsFromOfp(ofp);
  const planUnit = ofp && ofp.units === 'lb' ? 'lb' : 'kg';

  let mode = 'plan';
  let unit = ctx.prefs().units === 'lb' ? 'lb' : 'kg';
  let destroyed = false;

  const inputs = {
    oew: limitsOfp.oew ?? '',
    pax: limitsOfp.pax ?? '',
    paxWeight: '',
    crew: '',
    cargo: limitsOfp.cargo ?? '',
    fuel: ofp && ofp.fuel && ofp.fuel.takeoff != null ? ofp.fuel.takeoff : '',
    tripFuel: ofp && ofp.fuel && ofp.fuel.trip != null ? ofp.fuel.trip : '',
    mzfw: limitsOfp.mzfw ?? '',
    mtow: limitsOfp.mtow ?? '',
    mlw: limitsOfp.mlw ?? '',
    cg: '',
    cgMin: '',
    cgMax: '',
  };

  // Values carrying a plan unit are converted once for display.
  const shown = key => {
    const value = inputs[key];
    if (value === '' || value == null) return '';
    const n = Number(value);
    if (!Number.isFinite(n)) return value;
    return unit === planUnit ? n : Math.round(convertWeight(n, planUnit, unit));
  };

  function setInput(key, value) {
    // Weights are stored in the plan's unit so switching units never drifts;
    // a CG percentage is not a weight and is stored exactly as entered.
    if (key === 'cg' || key === 'cgMin' || key === 'cgMax') { inputs[key] = value; return; }
    const n = Number(value);
    if (value === '' || !Number.isFinite(n)) { inputs[key] = value; return; }
    inputs[key] = unit === planUnit ? n : Math.round(convertWeight(n, unit, planUnit));
  }

  function render() {
    const landing = plannedLandingWeight(ofp);
    const sheet = computeLoadSheet({
      oew: inputs.oew,
      pax: inputs.pax,
      paxWeight: inputs.paxWeight,
      crew: inputs.crew,
      cargo: inputs.cargo,
      fuel: inputs.fuel,
      tripFuel: inputs.tripFuel,
      limits: { unit: planUnit, mzfw: inputs.mzfw, mtow: inputs.mtow, mlw: inputs.mlw },
      cg: inputs.cg,
      cgEnvelope: { min: inputs.cgMin, max: inputs.cgMax },
    });
    const display = value => (value == null ? '—' : fmtWeight(unit === planUnit ? value : convertWeight(value, planUnit, unit), unit));
    const cgValue = ofp && limitsOfp.cg != null ? limitsOfp.cg : sheet.cg;
    const cgSource = ofp && limitsOfp.cg != null ? 'SimBrief' : sheet.cg != null ? 'entered' : null;

    const rows = [
      ['oew', 'Operating empty weight (OEW)'],
      ['zfw', 'Zero fuel weight (ZFW)'],
      ['tow', 'Takeoff weight (TOW)'],
      ['lw', 'Landing weight (LW)'],
    ];

    root.innerHTML = `
      <div class="e-row" style="margin-bottom:12px">
        <div class="e-seg" role="group" aria-label="Weight source">
          <button type="button" data-mode="plan" aria-pressed="${mode === 'plan'}">From the plan</button>
          <button type="button" data-mode="sheet" aria-pressed="${mode === 'sheet'}">Build a load sheet</button>
        </div>
        <span class="e-spacer"></span>
        <div class="e-seg" role="group" aria-label="Weight unit">
          <button type="button" data-unit="kg" aria-pressed="${unit === 'kg'}">kg</button>
          <button type="button" data-unit="lb" aria-pressed="${unit === 'lb'}">lb</button>
        </div>
      </div>

      ${mode === 'plan' ? planMode(display, landing, cgValue, cgSource) : sheetMode(display, sheet)}

      <div class="e-card" style="margin-top:12px">
        <h3>Centre of gravity</h3>
        ${cgValue != null
          ? `<div class="e-hero"><b>${esc(cgValue)}<small class="e-small e-faint"> %MAC</small></b><span>from ${esc(cgSource === 'SimBrief' ? 'the imported plan' : 'your entry')}</span></div>
             ${sheet.cgCheck ? `<div class="e-notice ${sheet.cgCheck.inside ? 'good' : 'bad'}" style="margin-top:9px">${sheet.cgCheck.inside ? 'Inside' : 'Outside'} the entered envelope ${sheet.cgCheck.min}–${sheet.cgCheck.max} %MAC.</div>` : '<div class="e-small e-faint" style="margin-top:7px">Enter the certified envelope below to have it checked.</div>'}`
          : `<div class="e-notice warn"><div><b>No centre of gravity</b><br>Neither the plan nor your entries state one. Stratos has no station/arm data for ${esc(aircraftLabel((ofp && ofp.aircraft && ofp.aircraft.icao) || ''))} and will not estimate a CG — a wrong trim figure is worse than a blank one.</div></div>`}
        <div class="e-grid three" style="margin-top:10px;gap:8px">
          <div class="e-field"><label for="wb-cg">Entered CG (%MAC)</label><input class="e-input small" id="wb-cg" data-key="cg" value="${esc(inputs.cg)}" inputmode="decimal" placeholder="optional"></div>
          <div class="e-field"><label for="wb-cgMin">Envelope minimum</label><input class="e-input small" id="wb-cgMin" data-key="cgMin" value="${esc(inputs.cgMin)}" inputmode="decimal"></div>
          <div class="e-field"><label for="wb-cgMax">Envelope maximum</label><input class="e-input small" id="wb-cgMax" data-key="cgMax" value="${esc(inputs.cgMax)}" inputmode="decimal"></div>
        </div>
      </div>

      <div class="e-small e-faint" style="margin:14px 2px 0">${ofp ? `Plan weights come from SimBrief (${esc(planUnit)}).` : 'No SimBrief plan is loaded, so every value here is yours.'} Limits are checked only against values that exist; a missing limit is never treated as a pass.</div>`;

    root.querySelectorAll('[data-mode]').forEach(button => {
      button.addEventListener('click', () => { mode = button.dataset.mode; render(); });
    });
    root.querySelectorAll('[data-unit]').forEach(button => {
      button.addEventListener('click', () => {
        const next = button.dataset.unit;
        if (next !== unit) { unit = next; ctx.setPrefs({ units: unit }); render(); }
      });
    });
    root.querySelectorAll('[data-key]').forEach(input => {
      input.addEventListener('input', () => {
        setInput(input.dataset.key, input.value);
        // Rebuild the totals but keep the caret in the field being typed in.
        const key = input.dataset.key;
        const caret = input.selectionStart;
        render();
        const again = root.querySelector(`[data-key="${key}"]`);
        if (again) {
          again.focus();
          if (caret != null && again.setSelectionRange) again.setSelectionRange(caret, caret);
        }
      });
    });
    if (mode === 'sheet') {
      const totals = root.querySelector('#wb-totals');
      if (totals) totals.dataset.ready = '1';
    }
  }

  function planMode(display, landing, cgValue, cgSource) {
    if (!ofp) {
      return `<div class="e-empty"><b>No plan loaded</b><p>Switch to <b>Build a load sheet</b> to enter your own weights, or import a SimBrief plan in Briefing first.</p><button class="e-btn small" type="button" data-open="briefing">Open Briefing</button></div>`;
    }
    const w = ofp.weights || {};
    const checks = [
      { key: 'zfw', label: 'Zero fuel weight', value: w.zfw, limit: w.mzfw },
      { key: 'tow', label: 'Takeoff weight', value: w.tow, limit: w.mtow },
      { key: 'lw', label: 'Landing weight', value: landing.value, limit: w.mlw },
    ];
    const total = w.mtow || 0;
    return `<div class="e-grid two" style="align-items:start">
      <div class="e-card">
        <h3>As filed <em>${esc(planUnit)}</em></h3>
        <dl class="e-kv">
          <dt>OEW</dt><dd>${display(w.oew)}</dd>
          <dt>Payload</dt><dd>${display(w.payload)}</dd>
          <dt>Passengers</dt><dd>${w.pax != null ? esc(w.pax) : '—'}</dd>
          <dt>Cargo</dt><dd>${display(w.cargo)}</dd>
          <dt>ZFW</dt><dd>${display(w.zfw)} <small>limit ${w.mzfw ? display(w.mzfw) : 'not stated'}</small></dd>
          <dt>TOW</dt><dd>${display(w.tow)} <small>limit ${w.mtow ? display(w.mtow) : 'not stated'}</small></dd>
          <dt>Landing weight</dt><dd>${display(landing.value)} <small>${landing.source === 'calculated' ? 'calculated from TOW − trip fuel' : 'from the plan'} · limit ${w.mlw ? display(w.mlw) : 'not stated'}</small></dd>
          <dt>CG</dt><dd>${cgValue != null ? `${esc(cgValue)} %MAC` : '<span class="e-faint">not stated</span>'}</dd>
        </dl>
        <div class="e-small e-faint" style="margin-top:8px">${w.mtow ? `MTOW ${display(w.mtow)}` : 'SimBrief did not report MTOW for this plan.'}</div>
      </div>
      <div class="e-card">
        <h3>Limits</h3>
        ${checks.map(check => {
          const value = Number(check.value);
          const limit = Number(check.limit);
          if (!Number.isFinite(value) || !Number.isFinite(limit) || limit <= 0) {
            return `<div style="margin-bottom:12px"><div class="e-row"><b class="e-small">${esc(check.label)}</b><span class="e-spacer"></span><span class="e-small e-faint">${display(check.value)}</span></div><div class="e-small e-faint">No limit published in the plan.</div></div>`;
          }
          const percent = Math.max(0, Math.min(1, value / limit));
          const over = value > limit;
          return `<div style="margin-bottom:12px">
            <div class="e-row"><b class="e-small">${esc(check.label)}</b><span class="e-spacer"></span><span class="e-small ${over ? '' : 'e-faint'}" style="${over ? 'color:var(--efb-bad)' : ''}">${fmtNum(Math.round((unit === planUnit ? value : convertWeight(value, planUnit, unit)) * 10) / 10)} / ${fmtNum(Math.round((unit === planUnit ? limit : convertWeight(limit, planUnit, unit)) * 10) / 10)} ${esc(unit)}</span></div>
            <div class="e-bar" data-state="${over ? 'bad' : percent > 0.96 ? 'warn' : 'good'}"><b style="width:${(percent * 100).toFixed(1)}%"></b></div>
            <div class="e-small e-faint">${over ? `${fmtNum(Math.round((unit === planUnit ? value - limit : convertWeight(value - limit, planUnit, unit))))} ${esc(unit)} over the limit` : `${fmtNum(Math.round((unit === planUnit ? limit - value : convertWeight(limit - value, planUnit, unit))))} ${esc(unit)} margin`}</div>
          </div>`;
        }).join('')}
        ${total ? `<div class="e-small e-faint">Bars are proportional to each weight's own limit.</div>` : ''}
      </div>
    </div>`;
  }

  function sheetMode(display, sheet) {
    const f = (key, label, hint = '') => `<div class="e-field">
      <label for="wb-${key}">${esc(label)}</label>
      <div class="e-row" style="gap:6px;flex-wrap:nowrap">
        <input class="e-input small" id="wb-${key}" data-key="${key}" value="${esc(shown(key))}" inputmode="decimal" placeholder="—">
        <span class="e-small e-faint">${esc(unit)}</span>
      </div>
      ${hint ? `<span class="e-hint">${esc(hint)}</span>` : ''}
    </div>`;
    return `<div class="e-grid two" style="align-items:start">
      <div class="e-card">
        <h3>Loading <em>${esc(unit)}</em></h3>
        <div class="e-grid two" style="gap:8px">
          ${f('oew', 'OEW')}
          ${f('pax', 'Passengers')}
          ${f('paxWeight', 'Weight per passenger', 'Your operator standard')}
          ${f('crew', 'Crew and equipment')}
          ${f('cargo', 'Cargo and baggage')}
          ${f('fuel', 'Takeoff fuel')}
          ${f('tripFuel', 'Trip fuel')}
        </div>
        <h3 style="margin-top:14px">Limits</h3>
        <div class="e-grid three" style="gap:8px">
          ${f('mzfw', 'Max ZFW')}
          ${f('mtow', 'Max TOW')}
          ${f('mlw', 'Max LW')}
        </div>
      </div>
      <div class="e-card">
        <h3>Result <em id="wb-totals">${sheet.complete ? 'calculated' : 'incomplete'}</em></h3>
        <dl class="e-kv">
          <dt>Payload</dt><dd>${display(sheet.payload)}</dd>
          <dt>ZFW</dt><dd>${display(sheet.zfw)}</dd>
          <dt>Takeoff weight</dt><dd>${display(sheet.tow)}</dd>
          <dt>Landing weight</dt><dd>${display(sheet.lw)}</dd>
        </dl>
        <div style="margin-top:12px">
          ${sheet.checks.map(check => `<div style="margin-bottom:12px"><div class="e-row"><b class="e-small">${esc(check.label)}</b><span class="e-spacer"></span><span class="e-small ${check.over ? '' : 'e-faint'}" style="${check.over ? 'color:var(--efb-bad)' : ''}">${check.checked ? `${display(check.value)} / ${display(check.limit)}` : display(check.value)}</span></div>${bar(check)}</div>`).join('')}
        </div>
        ${sheet.notes.length ? `<div class="e-notice" style="margin-top:6px"><div>${sheet.notes.map(note => esc(note)).join('<br>')}</div></div>` : ''}
      </div>
    </div>`;
  }

  root.addEventListener('click', event => {
    const open = event.target.closest('[data-open]');
    if (open) ctx.go(open.dataset.open);
  });

  render();
  return { destroy() { destroyed = true; } };
}
