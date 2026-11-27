"use strict";
const M = require("./model.cjs");
const Codes = require("./codes.cjs");
const Window = require("./activity-window.cjs");

const DAY = 86400000;
const stamp = (date, time = "00:00") => Date.parse(date + "T" + time + ":00Z");
const dayAt = at => new Date(at).toISOString().slice(0, 10);
const key = (...parts) => JSON.stringify(parts);
function bucket(map, id, create) {
  if (!map.has(id)) map.set(id, create());
  return map.get(id);
}
function indexDays(index, fields, span, item) {
  for (let at = stamp(dayAt(span.start)); at <= span.end; at += DAY)
    bucket(index, key(dayAt(at), ...fields), () => []).push(item);
}

// Findings do not store a session ID. Their recorded finder must have attended
// the session. An explicit notice session can include workers from several districts.
function leaderVenueScores(ws, { activities, findings, marked, resolveLeader, low, high, region, employment }) {
  const groups = new Map(), legacyAttendance = [], places = new Map();
  const inScope = span => span.start < high && span.end > low && (!region || span.region === region);
  const selectedSessions = new Set();
  for (const a of activities) {
    if (!a.sessionKey || (region && a.region !== region)) continue;
    const duration = M.minutes(a.start, a.end), start = stamp(a.date, a.start);
    if (duration && start < high && start + duration * 60000 > low) selectedSessions.add(a.sessionKey);
  }
  let untimedLeaderRecords = 0;
  for (const a of activities) {
    const duration = M.minutes(a.start, a.end), isLeader = marked(a.notes);
    if (!duration) {
      if (isLeader && (!region || a.region === region) && stamp(a.date) >= low && stamp(a.date) < high) untimedLeaderRecords++;
    }
    if (a.sessionKey && !selectedSessions.has(a.sessionKey)) continue;
    const start = stamp(a.date, a.start), end = start + duration * 60000;
    if (!a.sessionKey && (!duration || end <= low || start >= high)) continue;
    const place = bucket(places, a.place || "", () => Codes.label(ws, "activityPlace", a.place || "").trim());
    const member = resolveLeader(a, true);
    const span = { region: a.region || "", place, start, end, member, isLeader };
    if (!a.sessionKey) {
      if (member && place && span.region) legacyAttendance.push(span);
      if (!isLeader) continue;
    }
    const id = a.sessionKey || key(a.date, a.region, place, start, end);
    const group = bucket(groups, id, () => ({ explicit: !!a.sessionKey, spans: [], leaders: new Map(), places: new Set(), missingLeader: false }));
    if (duration) group.spans.push(span);
    if (isLeader) {
      if (member) group.leaders.set(member.identity, member);
      else group.missingLeader = true;
      group.places.add(place);
    }
  }

  const rows = new Map(), attendance = new Map(), legacyLeads = new Map();
  let unclearSessions = 0;
  function indexAttendance(group, span) {
    if (span.member && span.region && (!region || span.region === region))
      indexDays(attendance, [span.region, span.member.identity], span, { group, start: span.start, end: span.end });
  }
  for (const group of groups.values()) {
    const localSpans = group.spans.filter(inScope);
    if (!localSpans.length) continue;
    const leader = group.leaders.size === 1 && !group.missingLeader ? group.leaders.values().next().value : null;
    const place = group.places.size === 1 ? group.places.values().next().value : "";
    const ledSpans = group.spans.filter(s => s.isLeader);
    let documented = localSpans;
    if (group.explicit && leader && place && ledSpans.length) {
      documented = [];
      for (const span of localSpans) for (const lead of ledSpans) {
        const start = Math.max(span.start, lead.start), end = Math.min(span.end, lead.end);
        if (end > start && end > low && start < high) documented.push({ ...span, start, end });
      }
      if (!documented.length) continue;
    }
    if (leader && place && ledSpans.length) {
      group.row = bucket(rows, key(leader.identity, place), () => ({
        leaderId: leader.identity, name: leader.name, employment: leader.employment, place,
        sessions: 0, findings: 0,
      }));
      group.row.sessions++;
    } else unclearSessions++;
    for (const span of documented) {
      if (group.explicit) indexAttendance(group, span);
      else indexDays(legacyLeads, [span.region, span.place], span, { group, ...span });
    }
  }
  // Legacy attendance has no session ID. Require actual overlap at the same
  // recorded activity venue and district and credit only the overlapping time.
  for (const span of legacyAttendance) {
    if (region && span.region !== region) continue;
    const candidates = new Set();
    for (let at = stamp(dayAt(span.start)); at <= span.end; at += DAY) {
      const leads = legacyLeads.get(key(dayAt(at), span.region, span.place)) || [];
      for (const lead of leads) candidates.add(lead);
    }
    for (const lead of candidates) {
      const start = Math.max(span.start, lead.start), end = Math.min(span.end, lead.end);
      if (end > start) indexAttendance(lead.group, { ...span, start, end });
    }
  }
  let ambiguous = 0, unmatched = 0, assignedGlobal = 0;
  for (const finding of findings) {
    const member = resolveLeader(finding, true);
    if (!member || !finding.time || !finding.region) { unmatched++; continue; }
    const at = stamp(finding.date, finding.time);
    const spans = attendance.get(key(finding.date, finding.region, member.identity)) || [];
    const candidates = new Set(spans.filter(s => Window.contains(s, at)).map(s => s.group));
    if (candidates.size > 1) { ambiguous++; continue; }
    const group = candidates.values().next().value;
    if (!group?.row) { unmatched++; continue; }
    group.row.findings++;
    assignedGlobal++;
  }
  const scored = [...rows.values()].filter(row => !employment || row.employment === employment)
    .sort((a, b) => b.findings - a.findings || a.name.localeCompare(b.name, "ko") ||
      a.place.localeCompare(b.place, "ko") || a.leaderId.localeCompare(b.leaderId));
  let rank = 0, last = null, assigned = 0;
  for (const row of scored) {
    if (last !== row.findings) rank++;
    row.rank = rank;
    row.score = row.findings;
    row.perSession = row.findings / row.sessions;
    assigned += row.findings;
    last = row.findings;
  }
  return { rows: scored, assigned, outsideEmployment: assignedGlobal - assigned, ambiguous, unmatched, unclearSessions, untimedLeaderRecords };
}

module.exports = { leaderVenueScores };
