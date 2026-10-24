/* Terminal procedure geometry from real navigation data.
 *
 * The bridge returns the published legs for an airport from the simulator's
 * CIFP files, or from the dataset Stratos ships (the FAA's public-domain CIFP,
 * US airports) when the simulator has none: each SID, STAR and approach with
 * its ordered fixes, the leg terminators the source states, and the runway
 * thresholds. This module only decides which of that geometry concerns the plan
 * in front of it and which part of it is not already drawn as a
 * waypoint-to-waypoint leg.
 *
 * Rules:
 *  - A procedure is used only when the stored plan names it, and a runway
 *    transition only when the plan names that runway (or the combined "both"
 *    transition the source publishes for it).
 *  - A transition the source could not fully resolve is returned with
 *    complete:false so the caller can say the path is partial.
 *  - Nothing is invented: no arc, no turn, no route beyond the fixes the file
 *    gives. The path returned here is the runway transition at the end of the
 *    airport, not a replacement for the plan's own line.
 */

/** Query for one airport's procedures; kind and id narrow it when known. */
export function procedureEndpoint(airport, kind = '', ident = '') {
  const code = String(airport || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) return '';
  const query = new URLSearchParams({ airport: code });
  if (kind) query.set('kind', String(kind).toLowerCase());
  if (ident) query.set('id', String(ident).toUpperCase());
  return '/procedures.json?' + query.toString();
}

/** The plan's runway designator without the CIFP prefix ("RW16L" -> "16L"). */
export function normalizeRunway(value) {
  const text = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!text) return '';
  const bare = text.startsWith('RW') ? text.slice(2) : text;
  return /^\d{2}[LRCB]?$/.test(bare) ? bare : '';
}

/** One procedure by identifier from a payload, or null. */
export function procedureById(payload, kind, ident) {
  const list = payload && payload.procedures && payload.procedures[String(kind || '').toLowerCase()];
  if (!Array.isArray(list)) return null;
  const wanted = String(ident || '').trim().toUpperCase();
  if (!wanted) return null;
  return list.find(procedure => String(procedure.id || '').toUpperCase() === wanted) || null;
}

/**
 * The transition that belongs to this runway: the exact published one, or the
 * combined "both runways" transition whose number matches. Null when the
 * source publishes neither, so no runway is claimed.
 */
export function transitionFor(procedure, runway) {
  const rwy = normalizeRunway(runway);
  if (!procedure || !Array.isArray(procedure.transitions) || !rwy) return null;
  const exact = procedure.transitions.find(t => String(t.id || '').toUpperCase() === 'RW' + rwy);
  if (exact) return { transition: exact, combined: false, runway: rwy };
  const number = rwy.slice(0, 2);
  const combined = procedure.transitions.find(t => String(t.id || '').toUpperCase() === 'RW' + number + 'B');
  if (combined) return { transition: combined, combined: true, runway: rwy };
  return null;
}

function usable(point) {
  return point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon));
}

function clean(points) {
  const out = [];
  for (const point of points || []) {
    if (!usable(point)) continue;
    const lat = Number(point.lat);
    const lon = Number(point.lon);
    const previous = out[out.length - 1];
    if (previous && Math.abs(previous.lat - lat) < 1e-6 && Math.abs(previous.lon - lon) < 1e-6) continue;
    out.push({ id: String(point.id || ''), lat, lon, runway: Boolean(point.runway) });
  }
  return out;
}

/**
 * A trunk transition: the legs every aircraft flies, whatever the runway or
 * en-route entry. ARINC 424 publishes them as a blank or "ALL" transition.
 */
function isTrunk(transition) {
  const id = String((transition && transition.id) || '').toUpperCase();
  return id === '' || id === 'ALL';
}

function planFixIds(routeIds) {
  return new Set((routeIds || []).map(id => String(id || '').toUpperCase()).filter(Boolean));
}

function shared(transition, planIds) {
  if (!planIds.size) return 0;
  return (transition.points || []).filter(point => planIds.has(String(point.id || '').toUpperCase())).length;
}

/** Two transition pieces joined at the fix they share, never doubled. */
function joinTransition(first, second) {
  if (!first) return second;
  if (!second) return first;
  const head = first.points || [];
  const tail = second.points || [];
  const last = head[head.length - 1];
  const next = tail[0];
  const skip = last && next && String(last.id || '').toUpperCase() === String(next.id || '').toUpperCase() ? 1 : 0;
  return { id: [first.id, second.id].filter(Boolean).join('+'), points: [...head, ...tail.slice(skip)] };
}

/**
 * The verified legs of a procedure that publishes no runway connection.
 *
 * Most ARINC 424 files split a procedure into a common trunk plus en-route
 * transitions and publish no runway-specific legs at all: a STAR's trunk runs
 * from where its transitions converge to the terminal fix, a SID's trunk runs
 * from the runway area to where its transitions branch. Only those legs are
 * returned — the runway is not joined to them, because the source states no
 * such leg and a straight line into the field would be invented.
 */
function trunkPath(procedure, kind, routeIds) {
  const list = Array.isArray(procedure.transitions) ? procedure.transitions : [];
  const trunk = list.find(isTrunk) || null;
  const planIds = planFixIds(routeIds);
  /* The branch the plan flies: the one that starts on a planned fix, then the
     one sharing the most fixes with the plan. A tie is settled by the source's
     own order, never at random. */
  const enters = t => {
    const first = (t.points || [])[0];
    return first && planIds.has(String(first.id || '').toUpperCase()) ? 1 : 0;
  };
  const branch = planIds.size
    ? list.filter(t => !isTrunk(t) && shared(t, planIds) > 0)
      .map((t, index) => ({ t, index }))
      .sort((a, b) => enters(b.t) - enters(a.t) || shared(b.t, planIds) - shared(a.t, planIds) || a.index - b.index)
      .map(entry => entry.t)[0] || null
    : null;
  const isStar = String(kind || '').toLowerCase() === 'star';
  const joined = isStar ? joinTransition(branch, trunk) : joinTransition(trunk, branch);
  const points = (joined && joined.points) || [];
  if (points.length < 2) return null;
  return { points, transition: String((joined && joined.id) || ''), trunk: Boolean(trunk) };
}

/**
 * The published path for one procedure and runway, threshold included.
 *
 * A SID starts at its runway threshold and leaves along the transition; a STAR
 * arrives along its transition and ends at the threshold. `complete` is false
 * when the source had a leg it could not place, and `points` then holds only
 * the legs that were verified.
 *
 * When the source publishes no runway transition, the procedure's verified
 * trunk (and, with the plan's own fixes, the en-route transition it flies) is
 * returned instead with `runwayConnector:false`, so the runway is never joined
 * to the trunk by an invented leg.
 */
export function procedurePath(payload, { kind, ident, runway, routeIds } = {}) {
  if (!payload || !payload.ok) {
    return { ok: false, reason: 'unavailable', error: (payload && payload.error) || 'No procedure data for this airport.' };
  }
  const procedure = procedureById(payload, kind, ident);
  if (!procedure) return { ok: false, reason: 'not-in-data', error: `The navigation data has no ${String(kind || '').toUpperCase()} ${ident}.` };
  const match = transitionFor(procedure, runway);
  if (!match) {
    const trunk = trunkPath(procedure, kind, routeIds);
    if (!trunk) {
      return {
        ok: false, reason: 'no-runway-transition',
        error: `${procedure.id} has no runway transition for ${normalizeRunway(runway) || 'that runway'} in this data.`,
      };
    }
    const rwy = normalizeRunway(runway);
    const threshold = payload.runways && payload.runways[rwy];
    const points = clean(trunk.points);
    const endsAtAirport = points.length && String(points[points.length - 1].id).toUpperCase() === String(payload.airport || '').toUpperCase();
    const runwayPoint = endsAtAirport && usable(threshold)
      ? { id: 'RW' + rwy, lat: Number(threshold.lat), lon: Number(threshold.lon), runway: true }
      : null;
    const path = [...(endsAtAirport && runwayPoint ? points.slice(0, -1) : points), ...(runwayPoint ? [runwayPoint] : [])];
    return {
      ok: true,
      kind: String(kind).toLowerCase(),
      id: procedure.id,
      runway: runwayPoint ? rwy : '',
      transition: trunk.transition,
      combined: false,
      points: clean(path),
      skipped: 0,
      complete: true,
      runwayConnector: Boolean(runwayPoint),
      source: String(payload.source || ''),
      cycle: String(payload.cycle || ''),
      airport: String(payload.airport || ''),
    };
  }
  const rwy = match.runway;
  const threshold = payload.runways && payload.runways[rwy];
  const points = clean(match.transition.points);
  if (points.length < 1) return { ok: false, reason: 'empty', error: `${procedure.id} has no usable fixes in this data.` };
  const runwayPoint = usable(threshold)
    ? { id: 'RW' + rwy, lat: Number(threshold.lat), lon: Number(threshold.lon), runway: true }
    : null;
  let path;
  if (String(kind).toLowerCase() === 'star') {
    // A STAR's last leg is often "expect vectors" to the airport itself. The
    // published path already ends there, so the assigned runway replaces that
    // airport point instead of drawing a line into the middle of the field and
    // back out again.
    const endsAtAirport = points.length && String(points[points.length - 1].id).toUpperCase() === String(payload.airport || '').toUpperCase();
    path = [...(endsAtAirport && runwayPoint ? points.slice(0, -1) : points), ...(runwayPoint ? [runwayPoint] : [])];
  } else {
    path = [...(runwayPoint ? [runwayPoint] : []), ...points];
  }
  return {
    ok: true,
    kind: String(kind).toLowerCase(),
    id: procedure.id,
    runway: rwy,
    transition: String(match.transition.id || ''),
    combined: match.combined,
    points: clean(path),
    skipped: Number(match.transition.skipped) || 0,
    complete: match.transition.complete !== false,
    runwayConnector: true,
    source: String(payload.source || ''),
    cycle: String(payload.cycle || ''),
    airport: String(payload.airport || ''),
  };
}

/**
 * The part of a procedure path the plan does not already draw.
 *
 * Where the plan carries the procedure's own fixes, their legs are already on
 * the map and are left exactly as they are; this returns only the runway
 * connection at the airport (and any published fix the plan omitted).
 */
export function connectorFor(kind, points, routeIds, runwayId = '') {
  const ids = new Set((routeIds || []).map(id => String(id || '').toUpperCase()).filter(Boolean));
  const list = clean(points);
  if (list.length < 2) return [];
  const isStar = String(kind).toLowerCase() === 'star';
  if (!isStar) {
    const firstKnown = list.findIndex(point => point.id && ids.has(point.id.toUpperCase()));
    return list.slice(0, firstKnown >= 0 ? firstKnown + 1 : list.length);
  }
  let lastKnown = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].id && ids.has(list[i].id.toUpperCase())) { lastKnown = i; break; }
  }
  return list.slice(lastKnown >= 0 ? lastKnown : 0);
}

/** A sentence for the card: where the geometry came from, or why there is none. */
export function procedureNote(result) {
  if (!result) return '';
  if (!result.ok) return result.reason === 'no-runway-transition'
    ? 'No published runway transition for this runway'
    : (result.error || 'Procedure path unavailable');
  const cycle = result.cycle ? `AIRAC ${result.cycle}` : 'the simulator cycle';
  const provider = /^FAA/i.test(String(result.source || '')) ? ' · FAA CIFP dataset' : '';
  const combined = result.combined ? ' · combined runway transition' : '';
  const partial = result.complete ? '' : ` · ${result.skipped} leg${result.skipped === 1 ? '' : 's'} not in the data`;
  const noRunway = result.runwayConnector === false ? ' · the source publishes no runway leg, so the runway is not joined' : '';
  const where = result.runway ? `${result.id} ${result.runway} transition` : `${result.id} ${result.transition || 'common'} legs`;
  return `${where} from ${cycle}${provider}${combined}${partial}${noRunway}`;
}
