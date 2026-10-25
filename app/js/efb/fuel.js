/* EFB · Fuel Planning.
 *
 * The plan's fuel figures and a manual sheet, side by side with one
 * reconciliation: block fuel against the sum of its components, with the
 * difference shown rather than quietly absorbed. Every figure names where it came
 * from (SimBrief, calculated, entered). Units switch without re-entering numbers.
 */

import { esc, fmtMinutes, fmtNum, currentPlan } from './common.js';
import { arrivalSummary, fuelFromOfp, manualSheet, FUEL_COMPONENTS } from '../lib/fuelfigures.js';
import { convertWeight, fmtWeight } from '../lib/flightsummary.js';

export async function mount(root, ctx) {
  const plan = currentPlan();
  const ofp = plan && plan.ofp;
  const planUnit = ofp && ofp.units === 'lb' ? 'lb' : 'kg';
  const planFuel = ofp ? fuelFromOfp(ofp) : null;

  let mode = 'plan';
  let unit = ctx.prefs().units === 'lb' ? 'lb' : 'kg';
  // Manual entries are kept in the unit currently on screen and converted when
  // the unit changes, so a typed number never silently becomes a different one.
  const manual = { block: '' };
  for (const component of FUEL_COMPONENTS) manual[component.key] = '';

  /** Move every manual entry from one unit to another. */
  function switchManualUnit(next) {
    if (next === unit) return;
    for (const key of ['block', ...FUEL_COMPONENTS.map(component => component.key)]) {
      const raw = manual[key];
      if (raw === '' || raw == null) continue;
      const n = Number(raw);
      manual[key] = Number.isFinite(n) ? Math.round(convertWeight(n, unit, next)) : raw;
    }
  }
  const display = (value, from = planUnit) => {
    if (value == null) return '—';
    return fmtWeight(unit === from ? value : convertWeight(value, from, unit), unit);
  };

  function sourceTag(source) {
    if (source === 'ofp') return '<span class="e-badge accent">SimBrief</span>';
    if (source === 'calculated') return '<span class="e-badge">Calculated</span>';
    if (source === 'entered') return '<span class="e-badge">Entered</span>';
    return '<span class="e-badge bad">Not stated</span>';
  }

  function manualSheetNow() {
    const values = { unit: planUnit };
    for (const component of FUEL_COMPONENTS) {
      const raw = manual[component.key];
      const n = Number(raw);
      if (raw === '' || !Number.isFinite(n) || n < 0) { values[component.key] = null; continue; }
      values[component.key] = unit === planUnit ? n : convertWeight(n, unit, planUnit);
    }
    if (manual.block !== '') {
      const block = Number(manual.block);
      values.block = Number.isFinite(block) && block >= 0 ? (unit === planUnit ? block : convertWeight(block, unit, planUnit)) : null;
    }
    return manualSheet(values);
  }

  function sheetCard(sheet, title, sourceLabel) {
    const arrival = arrivalSummary(sheet);
    const hours = ofp && ofp.times && ofp.times.enrouteMin ? ofp.times.enrouteMin / 60 : null;
    const trip = sheet.rows.find(row => row.key === 'trip');
    const burn = hours && trip && trip.value != null ? Math.round(trip.value / hours) : null;
    return `<div class="e-card">
      <h3>${esc(title)} <span class="e-spacer"></span>${sourceTag(sourceLabel)}</h3>
      <dl class="e-kv">
        ${sheet.rows.map(row => `<dt>${esc(row.label)}</dt><dd>${row.value != null ? `${display(row.value)} ${sourceTag(row.source)}` : '<span class="e-faint">Not stated</span>'}</dd>`).join('')}
      </dl>
      <div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(148,163,184,.12)">
        <div class="e-row"><span class="e-small e-muted">Block fuel</span><span class="e-spacer"></span><b class="e-value">${display(sheet.block)}</b></div>
        <div class="e-row" style="margin-top:4px"><span class="e-small e-muted">Sum of components</span><span class="e-spacer"></span><span class="e-small ${sheet.balanced === false ? '' : 'e-faint'}" style="${sheet.balanced === false ? 'color:var(--efb-warn)' : ''}">${display(sheet.sum)}</span></div>
        ${sheet.difference != null ? `<div class="e-row" style="margin-top:4px"><span class="e-small e-muted">Difference</span><span class="e-spacer"></span><span class="e-small" style="${sheet.balanced === false ? 'color:var(--efb-warn)' : 'color:var(--efb-good)'}">${sheet.difference === 0 ? 'balanced' : `${display(Math.abs(sheet.difference))} ${sheet.balanced ? '' : '— does not reconcile'}`}</span></div>` : ''}
      </div>
      ${arrival ? `<div class="e-grid three" style="margin-top:12px;gap:8px">
        <div><div class="e-label">At destination</div><div class="e-value">${display(arrival.landing)}</div></div>
        <div><div class="e-label">Reserve + alternate</div><div class="e-value">${display(arrival.reservePlusAlternate)}</div></div>
        <div><div class="e-label">Average burn</div><div class="e-value">${burn != null ? `${fmtNum(burn)} ${esc(unit)}/h` : '—'}</div></div>
      </div>` : ''}
      ${sheet.notes.length ? `<div class="e-notice" style="margin-top:10px"><div>${sheet.notes.map(note => esc(note)).join('<br>')}</div></div>` : ''}
    </div>`;
  }

  function renderManual() {
    const sheet = manualSheetNow();
    return `<div class="e-grid two" style="align-items:start">
      <div class="e-card">
        <h3>Enter fuel <em>${esc(unit)}</em></h3>
        <div class="e-grid two" style="gap:8px">
          ${FUEL_COMPONENTS.map(component => `<div class="e-field">
            <label for="fuel-${component.key}">${esc(component.label)}</label>
            <div class="e-row" style="gap:6px;flex-wrap:nowrap">
              <input class="e-input small" id="fuel-${component.key}" data-component="${component.key}" value="${esc(manual[component.key])}" inputmode="decimal" placeholder="—">
              <span class="e-small e-faint">${esc(unit)}</span>
            </div>
            <span class="e-hint">${esc(component.hint)}</span>
          </div>`).join('')}
        </div>
        <div class="e-field" style="margin-top:8px">
          <label for="fuel-block">Block fuel override</label>
          <input class="e-input small" id="fuel-block" data-component="block" value="${esc(manual.block)}" inputmode="decimal" placeholder="Leave blank to total the components">
        </div>
      </div>
      ${sheetCard(sheet, 'Manual sheet', sheet.block != null ? 'entered' : 'entered')}
    </div>`;
  }

  function render() {
    const sheet = mode === 'plan' && planFuel ? planFuel : mode === 'plan' ? null : manualSheetNow();
    root.innerHTML = `
      <div class="e-row" style="margin-bottom:12px">
        <div class="e-seg" role="group" aria-label="Fuel source">
          <button type="button" data-mode="plan" aria-pressed="${mode === 'plan'}">From the plan</button>
          <button type="button" data-mode="manual" aria-pressed="${mode === 'manual'}">Manual</button>
        </div>
        <span class="e-spacer"></span>
        <div class="e-seg" role="group" aria-label="Fuel unit">
          <button type="button" data-unit="kg" aria-pressed="${unit === 'kg'}">kg</button>
          <button type="button" data-unit="lb" aria-pressed="${unit === 'lb'}">lb</button>
        </div>
      </div>
      ${mode === 'plan'
        ? (planFuel
          ? `<div class="e-grid two" style="align-items:start">${sheetCard(planFuel, 'As filed', 'ofp')}
              <div class="e-card"><h3>How to read this</h3>
                <dl class="e-kv">
                  <dt>Block fuel</dt><dd>SimBrief's plan_ramp, as filed</dd>
                  <dt>Components</dt><dd>Taxi, trip, contingency, alternate, reserve and extra, separately</dd>
                  <dt>Reconciliation</dt><dd>Block minus the sum of the components. A difference is shown, never absorbed.</dd>
                  <dt>At destination</dt><dd>The plan's landing fuel; if absent, takeoff fuel minus trip fuel</dd>
                </dl>
                <div class="e-notice" style="margin-top:10px">A component the plan does not state stays missing — it is not treated as zero, so nothing is double counted.</div>
              </div></div>`
          : `<div class="e-empty"><b>No fuel figures in this plan</b><p>Import a SimBrief plan with fuel to see it, or use the manual sheet.</p><button class="e-btn small" type="button" data-open="briefing">Open Briefing</button></div>`)
        : renderManual()}
      <div class="e-small e-faint" style="margin:14px 2px 0">Simulator planning aid. Fuel policy belongs to the operator; Stratos does not decide reserves.</div>`;

    root.querySelectorAll('[data-mode]').forEach(button => {
      button.addEventListener('click', () => { mode = button.dataset.mode; render(); });
    });
    root.querySelectorAll('[data-unit]').forEach(button => {
      button.addEventListener('click', () => {
        const next = button.dataset.unit;
        if (next !== unit) {
          switchManualUnit(next);
          unit = next;
          ctx.setPrefs({ units: unit });
          render();
        }
      });
    });
    if (mode === 'manual') {
      root.querySelectorAll('[data-component]').forEach(input => {
        input.addEventListener('input', () => {
          manual[input.dataset.component] = input.value;
          const card = root.querySelector('.e-grid.two > .e-card:last-child');
          if (card) {
            const sheet = manualSheetNow();
            const replacement = document.createElement('div');
            replacement.innerHTML = sheetCard(sheet, 'Manual sheet', 'entered');
            card.replaceWith(replacement.firstElementChild);
          }
        });
      });
    }
    const open = root.querySelector('[data-open]');
    if (open) open.addEventListener('click', () => ctx.go(open.dataset.open));
  }

  render();
  return { destroy() { /* nothing held */ } };
}
