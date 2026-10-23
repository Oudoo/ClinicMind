/* Views: appointments, consultations, assistant, conversations. */
(function () {
  const C = window.CM;
  const { esc, icon, badge, sectionTitle, emptyState, field, alert, avatar, fmtDate, fmtLongDate, fmtTime, dayKey, parseDay, addDays, n } = C;

  // ── Popover (dropdown menus) ────────────────────────────────────────────
  function popover(anchor, html) {
    closePopover();
    const r = anchor.getBoundingClientRect();
    const el = document.createElement("div");
    el.id = "popover"; el.setAttribute("role", "menu");
    el.className = "fixed z-50 min-w-[12rem] rounded-lg border border-border bg-card p-1 shadow-xl animate-fade-in";
    el.innerHTML = html;
    document.body.appendChild(el);
    const w = el.offsetWidth, hgt = el.offsetHeight;
    let left = Math.min(r.right - w, window.innerWidth - w - 8), top = r.bottom + 4;
    if (left < 8) left = 8;
    if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 4);
    el.style.left = `${left}px`; el.style.top = `${top}px`;
  }
  function closePopover() { const p = document.querySelector("#popover"); if (p) p.remove(); }
  document.addEventListener("click", (ev) => { if (!ev.target.closest("#popover") && !ev.target.closest("[data-action=apt-menu]")) closePopover(); }, true);
  const menuItem = (label, attrs, danger) => `<button class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted ${danger ? "text-danger" : ""}" role="menuitem" ${attrs}>${label}</button>`;

  // ── Appointments ────────────────────────────────────────────────────────
  const TRANSITIONS = { SCHEDULED: ["CONFIRMED", "CHECKED_IN", "CANCELLED", "NO_SHOW"], CONFIRMED: ["CHECKED_IN", "CANCELLED", "NO_SHOW"], CHECKED_IN: ["IN_PROGRESS", "COMPLETED", "CANCELLED"], IN_PROGRESS: ["COMPLETED"], WAITLISTED: ["SCHEDULED", "CANCELLED"], COMPLETED: [], CANCELLED: [], NO_SHOW: [] };
  const LABEL = { SCHEDULED: "Scheduled", CONFIRMED: "Confirmed", CHECKED_IN: "Checked in", IN_PROGRESS: "In progress", COMPLETED: "Completed", CANCELLED: "Cancelled", NO_SHOW: "No-show", WAITLISTED: "Waitlisted" };
  const TLABEL = { CONFIRMED: "Confirm", CHECKED_IN: "Check in", IN_PROGRESS: "Start consultation", COMPLETED: "Complete", CANCELLED: "Cancel", NO_SHOW: "Mark as no-show", SCHEDULED: "Schedule" };
  const TONE = { SCHEDULED: "default", CONFIRMED: "accent", CHECKED_IN: "accent", IN_PROGRESS: "accent", COMPLETED: "success", WAITLISTED: "warning", CANCELLED: "danger", NO_SHOW: "danger" };
  const NON_BLOCKING = ["CANCELLED", "NO_SHOW", "WAITLISTED"];
  const RESCHEDULABLE = ["SCHEDULED", "CONFIRMED", "WAITLISTED"];
  C.aptTone = (s) => TONE[s] || "default";
  C.aptLabel = (s) => LABEL[s] || s;

  const weekStart = (d) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 1) % 7)); return x; }; // Saturday
  const aptOf = (id) => C.S.appointments.find((a) => a.id === id);
  function conflicts(doctorId, start, end, excludeId) {
    return C.appointments().filter((a) => a.id !== excludeId && a.doctorId === doctorId && !NON_BLOCKING.includes(a.status) && new Date(a.startsAt) < end && new Date(a.endsAt) > start);
  }
  function aptCard(a, layout) {
    const p = C.patient(a.patientId), d = C.user(a.doctorId);
    const muted = a.status === "CANCELLED" || a.status === "NO_SHOW";
    const write = C.can(C.currentUser().role, "appointments:write");
    const showMenu = write && (TRANSITIONS[a.status].length || RESCHEDULABLE.includes(a.status));
    const time = `${fmtTime(a.startsAt)}–${fmtTime(a.endsAt)}`;
    const menu = showMenu ? `<button class="btn btn-ghost btn-icon h-7 w-7" data-action="apt-menu" data-id="${a.id}" aria-label="Actions for ${esc(p.fullName)}'s appointment">${icon("more")}</button>` : "";
    const details = `<a href="#/dashboard/patients/${p.id}" class="block truncate text-sm font-medium hover:underline ${muted ? "text-muted-foreground line-through" : ""}">${esc(p.fullName)}</a><p class="truncate text-xs text-muted-foreground">${esc(d ? d.fullName : "No doctor assigned")}${a.room ? ` · ${esc(a.room)}` : ""}</p>${a.reason ? `<p class="truncate text-xs text-muted-foreground" title="${esc(a.reason)}">${esc(a.reason)}</p>` : ""}${a.cancelReason && muted ? `<p class="truncate text-xs text-danger/80" title="${esc(a.cancelReason)}">${esc(a.cancelReason)}</p>` : ""}`;
    if (layout === "row") return `<article aria-label="${time} ${esc(p.fullName)}" class="flex flex-col gap-2 rounded-md border border-border bg-card p-3 sm:flex-row sm:items-center sm:gap-4"><span class="w-28 shrink-0 font-mono text-xs tabular-nums">${time}</span><div class="min-w-0 flex-1">${details}</div><div class="flex items-center justify-between gap-2 sm:justify-end">${badge(LABEL[a.status], TONE[a.status])}${menu}</div></article>`;
    return `<article aria-label="${time} ${esc(p.fullName)}" class="rounded-md border border-border bg-card p-2.5"><div class="flex flex-wrap items-center justify-between gap-x-1 gap-y-1"><span class="whitespace-nowrap font-mono text-xs tabular-nums">${time}</span><div class="ml-auto flex shrink-0 items-center gap-1">${badge(LABEL[a.status], TONE[a.status])}${menu}</div></div><div class="mt-1 space-y-0.5">${details}</div></article>`;
  }
  C.views.appointments = (r) => {
    const view = r.query.view === "day" ? "day" : "week";
    const date = r.query.date ? parseDay(r.query.date) : new Date();
    const doctor = r.query.doctor || "";
    const t = C.currentTenant();
    const all = C.appointments().filter((a) => !doctor || a.doctorId === doctor).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const link = (over) => `#/dashboard/appointments?${new URLSearchParams({ view, date: dayKey(date), doctor, ...over }).toString()}`;
    const step = view === "week" ? 7 : 1;
    const start = view === "week" ? weekStart(date) : date;
    const days = view === "week" ? [...Array(7)].map((_, i) => addDays(start, i)) : [date];
    const label = view === "week" ? `${C.pad(days[0].getDate())} ${C.MONTHS[days[0].getMonth()]} – ${C.pad(days[6].getDate())} ${C.MONTHS[days[6].getMonth()]} ${days[6].getFullYear()}` : fmtLongDate(date);
    const today = C.todayKey();
    const write = C.can(C.currentUser().role, "appointments:write");
    const toolbar = `<div class="bento flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between"><div class="flex items-center gap-2"><a class="btn btn-outline btn-icon" href="${link({ date: dayKey(addDays(date, -step)) })}" aria-label="Previous">${icon("chevron-left")}</a><a class="btn btn-outline btn-sm" href="${link({ date: C.todayKey() })}">Today</a><a class="btn btn-outline btn-icon" href="${link({ date: dayKey(addDays(date, step)) })}" aria-label="Next">${icon("chevron-right")}</a><span class="ml-2 text-sm font-medium">${label}</span></div><form class="flex flex-wrap items-center gap-2" data-form="apt-filter"><input type="hidden" name="view" value="${view}"><input type="hidden" name="date" value="${dayKey(date)}"><span class="inline-flex rounded-lg bg-muted p-1"><a href="${link({ view: "week" })}" class="rounded-md px-3 py-1 text-sm ${view === "week" ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}">Week</a><a href="${link({ view: "day" })}" class="rounded-md px-3 py-1 text-sm ${view === "day" ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}">Day</a></span><label class="data-label" for="apt-doctor">Doctor</label><select id="apt-doctor" name="doctor" class="input h-9 w-44"><option value="">All doctors</option>${C.doctors().map((d) => `<option value="${d.id}" ${doctor === d.id ? "selected" : ""}>${esc(d.fullName)}</option>`).join("")}</select><button class="btn btn-outline btn-sm" type="submit">Apply</button></form></div>`;
    let body;
    if (view === "week") body = `<div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-7">${days.map((d) => { const k = dayKey(d), list = all.filter((a) => dayKey(a.startsAt) === k); return `<section class="rounded-lg border ${k === today ? "border-accent ring-1 ring-accent" : "border-border"} bg-card/50 p-2"><header class="mb-2 flex items-center justify-between px-1"><span class="data-label ${k === today ? "text-accent" : ""}">${C.DAYS[d.getDay()]} ${C.pad(d.getDate())} ${C.MONTHS[d.getMonth()]}</span><span class="font-mono text-xs text-muted-foreground">${list.length}</span></header><div class="space-y-2">${list.length ? list.map((a) => aptCard(a, "compact")).join("") : `<p class="px-1 py-6 text-center font-mono text-xs text-muted-foreground">—</p>`}</div></section>`; }).join("")}</div>`;
    else { const list = all.filter((a) => dayKey(a.startsAt) === dayKey(date)); body = `<div class="bento space-y-2 p-4">${list.length ? list.map((a) => aptCard(a, "row")).join("") : emptyState("No appointments on this day", "Book one with “New appointment”.")}</div>`; }
    return `<div class="space-y-6">${sectionTitle("Appointments", `Schedule on the clinic clock (${esc(t.timezone || "Africa/Cairo")}). Conflicts are detected per doctor and room.`, write ? `<button class="btn btn-primary" data-action="new-appointment" data-date="${dayKey(date)}">${icon("calendar")} New appointment</button>` : "")}${toolbar}${body}</div>`;
  };
  C.forms["apt-filter"] = (d) => C.go(`/dashboard/appointments?${new URLSearchParams({ view: d.view, date: d.date, doctor: d.doctor }).toString()}`);

  // Patient picker (combobox) used by appointments, consultations and the assistant.
  C.patientPicker = function (idPrefix, selected, placeholder) {
    const sel = selected ? C.patient(selected) : null;
    return `<div id="${idPrefix}-picker" data-picker="${idPrefix}"><input type="hidden" name="patientId" id="${idPrefix}-id" value="${sel ? sel.id : ""}">${sel ? `<div class="flex items-center justify-between rounded-lg border border-input bg-background px-3 py-2 text-sm"><span class="truncate font-medium">${esc(sel.fullName)}</span><button type="button" class="text-xs text-accent hover:underline" data-action="picker-clear" data-prefix="${idPrefix}">Change</button></div>` : `<div class="relative"><input id="${idPrefix}-search" role="combobox" aria-expanded="false" aria-autocomplete="list" autocomplete="off" class="input" placeholder="${esc(placeholder || "Search patients by name or phone…")}"><ul id="${idPrefix}-list" role="listbox" aria-label="Matching patients" class="absolute left-0 right-0 top-full z-10 mt-1 hidden max-h-56 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-xl"></ul></div>`}</div>`;
  };
  C.mountPickers = function (root) {
    (root || document).querySelectorAll("[data-picker]").forEach((wrap) => {
      const prefix = wrap.dataset.picker, input = wrap.querySelector(`#${prefix}-search`), list = wrap.querySelector(`#${prefix}-list`);
      if (!input || input.dataset.mounted) return;
      input.dataset.mounted = "1";
      const update = () => {
        const q = input.value.trim().toLowerCase();
        if (q.length < 1) { list.classList.add("hidden"); return; }
        const hits = C.patients().filter((p) => !p.archivedAt && (p.fullName.toLowerCase().includes(q) || p.phone.includes(q))).slice(0, 8);
        list.innerHTML = hits.length ? hits.map((p) => `<li role="option"><button type="button" class="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted" data-action="picker-choose" data-prefix="${prefix}" data-id="${p.id}"><span class="truncate font-medium">${esc(p.fullName)}</span><span class="font-mono text-xs text-muted-foreground">${esc(p.phone)}</span></button></li>`).join("") : `<li class="px-3 py-2 text-xs text-muted-foreground">No patients match “${esc(input.value)}”.</li>`;
        list.classList.remove("hidden"); input.setAttribute("aria-expanded", "true");
      };
      input.addEventListener("input", update);
      input.addEventListener("focus", update);
    });
  };
  C.actions["picker-choose"] = (el) => { const wrap = document.querySelector(`#${el.dataset.prefix}-picker`); const p = C.patient(el.dataset.id); wrap.innerHTML = `<input type="hidden" name="patientId" id="${el.dataset.prefix}-id" value="${p.id}"><div class="flex items-center justify-between rounded-lg border border-input bg-background px-3 py-2 text-sm"><span class="truncate font-medium">${esc(p.fullName)}</span><button type="button" class="text-xs text-accent hover:underline" data-action="picker-clear" data-prefix="${el.dataset.prefix}">Change</button></div>`; wrap.dispatchEvent(new CustomEvent("picker-change", { bubbles: true, detail: { patientId: p.id } })); };
  C.actions["picker-clear"] = (el) => { const wrap = document.querySelector(`#${el.dataset.prefix}-picker`); wrap.outerHTML = C.patientPicker(el.dataset.prefix, null); C.mountPickers(); const i = document.querySelector(`#${el.dataset.prefix}-search`); if (i) i.focus(); document.dispatchEvent(new CustomEvent("picker-change", { bubbles: true, detail: { patientId: null } })); };

  function aptForm(a, preset) {
    const date = a ? dayKey(a.startsAt) : preset.date || C.todayKey();
    const time = a ? fmtTime(a.startsAt) : "09:00";
    const dur = a ? Math.round((new Date(a.endsAt) - new Date(a.startsAt)) / 60000) : 30;
    return `<form data-form="save-appointment" class="space-y-4" novalidate><input type="hidden" name="id" value="${a ? a.id : ""}"><div id="apt-error"></div>
      ${a ? "" : field("Patient", C.patientPicker("na", preset.patientId), null)}
      ${field("Doctor", `<select id="na-doctor" name="doctorId" class="input">${a ? "" : `<option value="">Choose a doctor</option>`}${C.doctors().map((d) => `<option value="${d.id}" ${a && a.doctorId === d.id ? "selected" : ""}>${esc(d.fullName)}</option>`).join("")}</select>`, null, "na-doctor")}
      <div class="grid grid-cols-3 gap-3">${field("Date", `<input id="na-date" name="date" type="date" class="input" value="${date}">`, null, "na-date")}${field("Start", `<input id="na-time" name="time" type="time" class="input" value="${time}">`, null, "na-time")}${field("Duration", `<select id="na-duration" name="duration" class="input">${[15, 20, 30, 45, 60].map((m) => `<option value="${m}" ${m === dur ? "selected" : ""}>${m} min</option>`).join("")}</select>`, null, "na-duration")}</div>
      ${field("Room", `<select id="na-room" name="room" class="input">${window.CM_SEED.ROOMS.map((rm) => `<option ${a && a.room === rm ? "selected" : ""}>${rm}</option>`).join("")}</select>`, null, "na-room")}
      ${field("Reason", `<input id="na-reason" name="reason" class="input" placeholder="e.g. Follow-up, blood pressure check" value="${esc(a ? a.reason : "")}">`, "Optional · shown on the schedule", "na-reason")}
      ${field("Notes", `<textarea id="na-notes" name="notes" class="input min-h-[4rem]">${esc(a ? a.notes : "")}</textarea>`, "Optional · for the front desk and the doctor", "na-notes")}
      <div class="flex items-center justify-end gap-2"><button type="button" class="btn btn-outline" data-action="close-dialog">Close</button><button type="submit" class="btn btn-primary">${a ? "Save new time" : "Book appointment"}</button></div></form>`;
  }
  C.actions["new-appointment"] = (el) => C.openDialog({ title: "New appointment", description: "Times on the clinic clock (Africa/Cairo).", body: aptForm(null, { patientId: el.dataset.patient, date: el.dataset.date }), onMount: () => C.mountPickers() });
  C.actions["apt-reschedule"] = (el) => { closePopover(); const a = aptOf(el.dataset.id); C.openDialog({ title: "Reschedule", description: `${esc(C.patient(a.patientId).fullName)} · currently ${fmtDate(a.startsAt)} ${fmtTime(a.startsAt)}`, body: aptForm(a, {}) }); };
  C.forms["save-appointment"] = (d, form) => {
    const box = form.querySelector("#apt-error");
    const existing = d.id ? aptOf(d.id) : null;
    const patientId = existing ? existing.patientId : d.patientId;
    if (!patientId) { box.innerHTML = alert("Choose a patient."); return; }
    if (!d.doctorId) { box.innerHTML = alert("Choose a doctor."); return; }
    if (!d.date || !d.time) { box.innerHTML = alert("Choose a date and a start time."); return; }
    const [h, m] = d.time.split(":").map(Number); const day = parseDay(d.date);
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m), end = new Date(start.getTime() + Number(d.duration) * 60000);
    const clash = conflicts(d.doctorId, start, end, existing ? existing.id : null);
    if (clash.length && !d.waitlist) {
      box.innerHTML = `<div role="alert" class="rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger"><p class="font-medium">That slot is already taken.</p>${clash.map((c) => `<p class="mt-1 font-mono text-xs">${fmtDate(c.startsAt).slice(0, 6)} ${fmtTime(c.startsAt)}–${fmtTime(c.endsAt)} · ${esc(C.user(c.doctorId).fullName)} · ${esc(c.room || "")} · ${esc(C.patient(c.patientId).fullName)}</p>`).join("")}${existing ? "" : `<button type="button" class="btn btn-outline btn-sm mt-2 border-danger/40 text-danger" data-action="apt-waitlist">Waitlist instead</button>`}</div>`;
      form.scrollIntoView({ block: "start" });
      return;
    }
    const pName = C.patient(patientId).fullName;
    if (existing) { Object.assign(existing, { doctorId: d.doctorId, startsAt: start.toISOString(), endsAt: end.toISOString(), room: d.room, reason: d.reason.trim(), notes: d.notes }); if (existing.status === "WAITLISTED" && !clash.length) existing.status = "SCHEDULED"; C.logAudit("appointment.reschedule", "Appointment", existing.id); C.save(); C.closeDialog(); C.toast({ title: `${pName} · rescheduled`, description: `${fmtDate(start)} ${fmtTime(start)}` }); C.go(`/dashboard/appointments?view=day&date=${d.date}`); return; }
    const a = { id: C.newId("apt"), tenantId: C.tid(), patientId, doctorId: d.doctorId, room: d.room, startsAt: start.toISOString(), endsAt: end.toISOString(), status: d.waitlist ? "WAITLISTED" : "SCHEDULED", reason: d.reason.trim(), notes: d.notes, cancelReason: null, createdAt: new Date().toISOString() };
    C.S.appointments.push(a);
    C.S.timeline.push({ id: C.newId("tl"), tenantId: C.tid(), patientId, kind: "APPOINTMENT", at: a.startsAt, title: `Appointment — ${a.reason || "Visit"}`, body: a.status === "WAITLISTED" ? "Waitlisted" : "" });
    C.logAudit("appointment.create", "Appointment", a.id); C.save(); C.closeDialog();
    C.toast({ title: a.status === "WAITLISTED" ? `${pName} · waitlisted` : `${pName} · booked`, description: `${fmtDate(start)} ${fmtTime(start)} with ${C.user(d.doctorId).fullName}` });
    C.go(`/dashboard/appointments?view=day&date=${d.date}`);
  };
  C.actions["apt-waitlist"] = (el) => { const form = el.closest("form"); const hidden = document.createElement("input"); hidden.type = "hidden"; hidden.name = "waitlist"; hidden.value = "1"; form.appendChild(hidden); form.requestSubmit(); };
  C.actions["apt-menu"] = (el) => {
    const a = aptOf(el.dataset.id);
    const items = TRANSITIONS[a.status].filter((s) => s !== "CANCELLED" && s !== "NO_SHOW").map((s) => menuItem(TLABEL[s], `data-action="apt-transition" data-id="${a.id}" data-to="${s}"`));
    if (RESCHEDULABLE.includes(a.status)) items.push(menuItem(`${icon("clock")} Reschedule`, `data-action="apt-reschedule" data-id="${a.id}"`));
    const destructive = TRANSITIONS[a.status].filter((s) => s === "CANCELLED" || s === "NO_SHOW").map((s) => menuItem(TLABEL[s], `data-action="apt-transition" data-id="${a.id}" data-to="${s}"`, true));
    popover(el, `${items.join("")}${items.length && destructive.length ? `<div class="my-1 h-px bg-border"></div>` : ""}${destructive.join("")}`);
  };
  C.actions["apt-transition"] = (el) => {
    closePopover();
    const a = aptOf(el.dataset.id), to = el.dataset.to, p = C.patient(a.patientId);
    if (to === "CANCELLED") { C.openDialog({ title: "Cancel this appointment?", description: `${esc(p.fullName)} · ${fmtDate(a.startsAt)} ${fmtTime(a.startsAt)}. The reason stays on the record and the patient timeline.`, body: `<form data-form="cancel-appointment" class="space-y-4" novalidate><input type="hidden" name="id" value="${a.id}"><div id="cancel-error"></div>${field("Reason", `<input id="cancel-reason" name="reason" class="input" maxlength="300" placeholder="e.g. Patient travelling" required>`, "Required", "cancel-reason")}<div class="flex justify-end gap-2"><button type="button" class="btn btn-outline" data-action="close-dialog">Keep it</button><button class="btn btn-danger" type="submit">Cancel appointment</button></div></form>` }); return; }
    a.status = to; C.logAudit("appointment.transition", "Appointment", a.id, { to });
    if (to === "NO_SHOW") { const ev = C.S.timeline.find((t) => t.patientId === a.patientId && t.kind === "APPOINTMENT" && t.at === a.startsAt); if (ev) ev.body = "No-show"; }
    C.save(); C.toast({ title: `${p.fullName} · ${LABEL[to]}` }); C.render();
  };
  C.forms["cancel-appointment"] = (d, form) => { if (!d.reason.trim()) { form.querySelector("#cancel-error").innerHTML = alert("Give a reason for the cancellation."); return; } const a = aptOf(d.id); a.status = "CANCELLED"; a.cancelReason = d.reason.trim(); const ev = C.S.timeline.find((t) => t.patientId === a.patientId && t.kind === "APPOINTMENT" && t.at === a.startsAt); if (ev) ev.body = `Cancelled: ${a.cancelReason}`; C.logAudit("appointment.cancel", "Appointment", a.id); C.save(); C.closeDialog(); C.toast({ title: `${C.patient(a.patientId).fullName} · Cancelled` }); C.render(); };

  // ── Consultations ───────────────────────────────────────────────────────
  const CLABEL = { PENDING_REVIEW: "Pending review", SIGNED: "Signed", DISCARDED: "Discarded" };
  const CTONE = { PENDING_REVIEW: "warning", SIGNED: "success", DISCARDED: "default" };
  const edits = {}; // working copies of drafts being reviewed, keyed by consultation id
  C.lastSign = null;

  // Heuristic extraction. The real product runs an LLM with a strict JSON schema; the prototype
  // recognises common dermatology/hair drugs and conditions so a pasted transcript becomes a draft.
  const rxEsc = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const DRUGS = ["minoxidil", "finasteride", "dutasteride", "triamcinolone", "isotretinoin", "tretinoin", "adapalene", "benzoyl peroxide", "clindamycin", "doxycycline", "minocycline", "azithromycin", "amoxicillin", "cephalexin", "hydroquinone", "tranexamic acid", "azelaic acid", "kojic acid", "niacinamide", "salicylic acid", "glycolic acid", "metformin", "levothyroxine", "spironolactone", "methotrexate", "cyclosporine", "prednisolone", "prednisone", "cetirizine", "loratadine", "fexofenadine", "hydroxyzine", "hydroxychloroquine", "ketoconazole", "clobetasol", "mometasone", "betamethasone", "calcipotriol/betamethasone", "calcipotriol", "hydrocortisone", "tacrolimus", "pimecrolimus", "ivermectin", "metronidazole", "permethrin", "terbinafine", "fluconazole", "itraconazole", "acyclovir", "valacyclovir", "dapsone", "colchicine", "omalizumab", "dupilumab", "apremilast", "baricitinib", "tofacitinib", "biotin", "vitamin d", "vitamin c", "ferrous sulfate", "ferrous sulphate", "iron supplement", "zinc", "omega-3", "emollient", "moisturiser", "moisturizer", "sunscreen", "saline spray", "coal tar shampoo", "ketoconazole shampoo", "urea", "paracetamol", "ibuprofen", "aspirin", "atorvastatin", "amlodipine", "lisinopril", "losartan", "insulin"];
  const DRUG_RE = new RegExp(`\\b(${DRUGS.slice().sort((a, b) => b.length - a.length).map(rxEsc).join("|")})\\b`, "gi");
  const DRUG_SET = new Set(DRUGS);
  const GENERIC_RE = /\b[A-Za-z]{4,}(?:olol|ide|ine|one|ate|cin|mab|nib|azole|oxacin|pril|sartan|statin|mycin|cycline|dronate|vir|xaban|gliptin|formin|lone|sone|zine|dine|tide|xib|pam|lam)\b/g;
  const BRAND_RE = /(?<=\s)[A-Z][a-z]{3,}(?=\s+(?:\d|one|two|three|half)\b)/g;
  const COMMON = new Set(["alone", "done", "gone", "phone", "define", "line", "fine", "nine", "zone", "stone", "state", "create", "medicine", "machine", "examine", "routine", "clone", "tone", "bone", "date", "late", "rate", "plate", "estate", "indicate", "vaccine", "none", "someone", "anyone", "everyone", "online", "outline", "decline", "combine", "baseline", "guideline", "timeline", "determine", "hormone", "mine", "wine", "shine", "spine", "genuine", "imagine", "discipline", "appropriate", "immediate", "moderate", "separate", "private", "accurate", "delicate", "adequate", "ultimate", "climate", "candidate", "evaluate", "alternate", "update", "protocol", "alcohol", "control", "school", "decide", "provide", "inside", "outside", "beside", "aside", "guide", "slide", "wide", "divide", "pride", "worldwide", "nationwide", "patient", "sunshine", "deadline", "headline", "pipeline", "feminine", "masculine", "cuisine", "magazine", "marine", "caffeine", "nicotine", "protein", "tomorrow", "exam", "program", "spam", "balsam", "bedlam", "crystalline", "milestone", "ozone", "cortisone"]);
  const STRENGTH_RE = /^\s*(\d+(?:\.\d+)?)\s?%(?:\s+(solution|cream|gel|lotion|shampoo|spray|foam|ointment|serum|wash|plaster|drops))?/i;
  const FORM_RE = /^\s+(cream|gel|lotion|shampoo|spray|foam|ointment|serum|wash|solution|tablets?|capsules?|drops|plaster)\b/i;
  const DOSE_RE = /(\d+(?:\.\d+)?)\s?(mg\/ml|mg\/g|mg|ml|mcg|µg|g|iu|units?)\b|\b(a|one|two|three|four|half)\s+(millilitres?|milliliters?|milligrams?|tablets?|capsules?|drops?|puffs?|pumps?|sachets?|applications?)\b|\b(thin layer|pea-sized amount|as directed|liberally|generously|generous amount|fingertip unit|apply|spf\s?\d+)\b/i;
  const FREQ_RE = /\b(once daily|twice daily|three times daily|four times daily|once a day|twice a day|three times a day|four times a day|every (?:morning|night|evening|other day|\d+ (?:hours|days|weeks|months)|second day)|(?:at|before) (?:night|bedtime|bed)|in the morning|each morning|each night|nightly|daily|weekly|monthly|as needed|when needed|as required|at each (?:visit|session)|every session|every (?:\d+|two|three|four) (?:hours|days|weeks|months))\b/i;
  const DURATION_RE = /\bfor (\d+|one|two|three|four|five|six|seven|eight|ten|twelve) (days?|weeks?|months?)\b/i;
  const ROUTE_RE = /(?:^|\s)(intralesional|topical|oral|intramuscular|subcutaneous|intravenous)\s+$/i;
  const WORD_NUM = { a: 1, one: 1, two: 2, three: 3, four: 4, half: 0.5 };
  const unitOf = (u) => u.toLowerCase().replace(/^millilit(?:re|er)s?$/, "ml").replace(/^milligrams?$/, "mg");
  function fmtDose(m) { if (m[1]) return `${m[1]} ${m[2].toLowerCase()}`; if (m[3]) return `${WORD_NUM[m[3].toLowerCase()]} ${unitOf(m[4])}`; return cap(m[5].toLowerCase()).replace(/^Spf\s?/, "SPF "); }
  function extractMeds(lines) {
    const out = [];
    for (const line of lines) for (const clause of line.split(/[.;](?:\s|$)/)) {
      const text = clause.trim(); if (!text) continue;
      const cands = []; let m;
      DRUG_RE.lastIndex = 0; while ((m = DRUG_RE.exec(text))) cands.push({ i: m.index, name: m[0], dict: true });
      const inside = (i) => cands.some((c) => c.i <= i && i < c.i + c.name.length);
      GENERIC_RE.lastIndex = 0; while ((m = GENERIC_RE.exec(text))) if (!inside(m.index) && !COMMON.has(m[0].toLowerCase())) cands.push({ i: m.index, name: m[0], dict: false });
      BRAND_RE.lastIndex = 0; while ((m = BRAND_RE.exec(text))) if (!inside(m.index)) cands.push({ i: m.index, name: m[0], dict: false });
      cands.sort((a, b) => a.i - b.i);
      cands.forEach((c, k) => {
        const tail = text.slice(c.i + c.name.length, cands[k + 1] ? cands[k + 1].i : undefined);
        let name = c.name, rest = tail;
        const strength = STRENGTH_RE.exec(rest);
        if (strength) { name += ` ${strength[1]}%${strength[2] ? ` ${strength[2].toLowerCase()}` : ""}`; rest = rest.slice(strength[0].length); }
        const form = FORM_RE.exec(rest);
        if (form && !strength) { name += ` ${form[1].toLowerCase()}`; rest = rest.slice(form[0].length); }
        const route = ROUTE_RE.exec(text.slice(0, c.i));
        if (route) name = `${route[1].toLowerCase()} ${name}`;
        const dose = DOSE_RE.exec(rest), freq = FREQ_RE.exec(rest), dur = DURATION_RE.exec(rest);
        if (!c.dict && !dose && !freq) return;
        if (c.dict && !dose && !freq && !strength && !form && !/\b(start|use|apply|take|continue|repeat|prescribe|give|add|switch|increase|reduce)\b/i.test(text)) return;
        let frequency = freq ? cap(freq[1].toLowerCase()) : /\btoday\b/i.test(rest) ? "Single dose today" : "";
        if (dur) frequency = `${frequency || "Daily"} for ${dur[1]} ${dur[2]}`.replace(/^Daily for/, "Daily for");
        out.push({ name: cap(name), dosage: dose ? fmtDose(dose) : strength || form ? "As directed" : "", frequency });
      });
    }
    return out.filter((m, i, arr) => arr.findIndex((x) => x.name.toLowerCase() === m.name.toLowerCase()) === i);
  }
  const CONDITION_NAMES = [...new Set([...((window.CM_SEED && window.CM_SEED.CONDITIONS) || []).flatMap((c) => c.chronic), "Alopecia areata", "Androgenetic alopecia", "Telogen effluvium", "Traction alopecia", "Scarring alopecia", "Frontal fibrosing alopecia", "Melasma", "Acne vulgaris", "Acne", "Papulopustular rosacea", "Rosacea", "Atopic dermatitis", "Eczema", "Contact dermatitis", "Seborrheic dermatitis", "Plaque psoriasis", "Psoriasis", "Vitiligo", "Chronic urticaria", "Urticaria", "Tinea capitis", "Tinea corporis", "Tinea versicolor", "Folliculitis", "Post-inflammatory hyperpigmentation", "Hyperpigmentation", "Keloid", "Hypertrophic scar", "Plantar warts", "Warts", "Molluscum contagiosum", "Impetigo", "Scabies", "Lichen planus", "Hidradenitis suppurativa", "Actinic keratosis", "Basal cell carcinoma", "Hirsutism", "Hypothyroidism", "Iron deficiency anaemia", "Iron deficiency", "Hypertension", "Type 2 diabetes", "Diabetes", "PCOS"])].sort((a, b) => b.length - a.length);
  const COND_RE = new RegExp(`\\b(${CONDITION_NAMES.map(rxEsc).join("|")})\\b`, "gi");
  function extract(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const doctor = [], patient = [];
    for (const l of lines) { const m = /^(doctor|dr\.?|clinician|physician)\s*:\s*(.*)$/i.exec(l); const pm = /^(patient|pt\.?)\s*:\s*(.*)$/i.exec(l); if (m) doctor.push(m[2]); else if (pm) patient.push(pm[2]); else doctor.push(l); }
    const clean = (s) => s.replace(/^(and|but|so|also|then)\s+/i, "").replace(/[.;:]+$/, "").trim();
    const symptoms = [];
    for (const l of patient) for (const part of l.split(/[.;]|,\s+(?:and\s+)?|\s+and\s+/i)) { const s = clean(part); if (s.length > 4 && s.length < 70 && !/^(no|yes|okay|ok|sure|thank you|thanks|only .*tablets?|not really|nothing else|that'?s all)$/i.test(s)) symptoms.push((s.charAt(0).toLowerCase() + s.slice(1)).replace(/\bi\b/g, "I")); }
    const diagnoses = [];
    for (const l of doctor) { const m = /(?:consistent with|diagnos(?:is|ed)(?: is| of| as)?|this is|looks like|impression(?: is)?)\s+(?:an?\s+|the\s+)?([^.;,]+)/i.exec(l); if (m) { const d = clean(m[1]).replace(/\s+(?:with|and)\s+.*$/i, ""); if (d) diagnoses.push(cap(d)); } }
    for (const l of doctor) { let m; COND_RE.lastIndex = 0; while ((m = COND_RE.exec(l))) { const canon = CONDITION_NAMES.find((c) => c.toLowerCase() === m[1].toLowerCase()) || cap(m[1]); if (!diagnoses.some((d) => d.toLowerCase().includes(canon.toLowerCase()))) diagnoses.push(canon); } }
    const medications = extractMeds(doctor);
    const tests = [];
    const testRe = /\b(TSH|ferritin|CBC|full blood count|trichoscopy|dermoscopy|wood'?s lamp(?: examination)?|(?:skin|scalp|punch)? ?biopsy|hormonal profile|thyroid function(?: tests?)?|blood work|blood tests?|swab|culture|vitamin d|glucose|HbA1c|liver function|lipid profile|patch test|iron studies|prolactin|testosterone|KOH (?:prep|test)|blood pressure)\b/gi;
    for (const l of doctor) { let m; while ((m = testRe.exec(l))) { const t = m[1].trim().replace(/(^|\s)(\w)/g, (_, sp, c) => sp + c.toUpperCase()).replace("Tsh", "TSH").replace("Cbc", "CBC").replace("Hba1c", "HbA1c").replace("Koh", "KOH"); if (!tests.includes(t)) tests.push(t); } }
    const followUps = [];
    for (const l of doctor) { const m = /((?:review|follow[- ]up|see (?:you|him|her)|come back|return|next session|next injection|injection|photos?)\s+(?:in|after|at)\s+[^.;]+)/i.exec(l); if (m) followUps.push(cap(clean(m[1]))); }
    const dedupe = (xs) => [...new Set(xs)];
    const out = { symptoms: dedupe(symptoms).slice(0, 6), diagnoses: dedupe(diagnoses).filter((d, i, arr) => !arr.some((o, j) => j !== i && o.length > d.length && o.toLowerCase().includes(d.toLowerCase()))).slice(0, 3), tests: dedupe(tests).slice(0, 5), followUps: dedupe(followUps).slice(0, 4), medications: medications.slice(0, 6) };
    const empty = !out.symptoms.length && !out.diagnoses.length && !out.tests.length && !out.followUps.length && !out.medications.length;
    const summary = empty ? "" : [out.diagnoses[0], out.medications.length ? `Plan: ${out.medications.map((m) => [m.name, m.dosage, m.frequency.toLowerCase()].filter(Boolean).join(" ")).join("; ")}` : "", out.followUps[0]].filter(Boolean).join(". ") + ".";
    return { ...out, empty, summary };
  }
  C.extract = extract;

  const cons = (id) => C.S.consultations.find((c) => c.id === id);
  C.views.consultations = (r) => {
    const canSign = C.can(C.currentUser().role, "consultations:sign");
    const filter = r.query.filter || "ALL";
    let list = C.consultations().slice();
    if (filter !== "ALL") list = list.filter((c) => c.status === filter);
    list.sort((a, b) => (a.status === "PENDING_REVIEW" ? 0 : 1) - (b.status === "PENDING_REVIEW" ? 0 : 1) || b.createdAt.localeCompare(a.createdAt));
    const pending = C.consultations().filter((c) => c.status === "PENDING_REVIEW").length;
    const open = r.query.open ? cons(r.query.open) : null;
    const right = open ? reviewPanel(open, canSign) : captureForm(r.query.patient);
    return `<div class="space-y-6">${sectionTitle("Consultation Intelligence", "Transcript → extract → review → sign. Nothing reaches the patient record until a clinician signs.", badge(`${pending} pending review`, "warning"))}
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_1fr]"><div class="bento min-w-0 self-start p-0"><div class="flex items-start justify-between gap-3 border-b border-border p-4"><div><h3 class="font-display text-lg font-semibold">Consultations</h3><p class="text-xs text-muted-foreground">${n(C.consultations().length)} records · pending review first</p></div><a class="btn btn-primary btn-sm" href="#/dashboard/consultations">${icon("plus")} New consultation</a></div><div class="border-b border-border p-4"><label class="data-label mb-1.5 block" for="c-filter">Show</label><select id="c-filter" class="input h-9" data-action-change="consult-filter">${[["ALL", "All consultations"], ["PENDING_REVIEW", "Pending review"], ["SIGNED", "Signed"], ["DISCARDED", "Discarded"]].map(([v, l]) => `<option value="${v}" ${filter === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>${list.length ? `<ul class="max-h-[70vh] divide-y divide-border overflow-y-auto" aria-label="Consultations">${list.slice(0, 60).map((c) => { const p = C.patient(c.patientId), d = C.user(c.doctorId); return `<li><a href="#/dashboard/consultations?open=${c.id}&filter=${filter}" aria-current="${open && open.id === c.id}" class="flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-muted/60 ${open && open.id === c.id ? "bg-accent-muted/60" : ""}"><span class="flex items-center justify-between gap-2"><span class="truncate text-sm font-medium">${esc(p ? p.fullName : "")}</span>${badge(CLABEL[c.status], CTONE[c.status])}</span><span class="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>${fmtDate(c.createdAt)} · ${fmtTime(c.createdAt)}</span>${d ? `<span class="truncate">${esc(d.fullName)}</span>` : ""}</span></a></li>`; }).join("")}</ul>` : `<div class="p-4">${emptyState(filter === "ALL" ? "No consultations yet" : "Nothing with this status", "Start one with “New consultation”.")}</div>`}</div><div class="min-w-0">${right}</div></div></div>`;
  };
  document.addEventListener("change", (ev) => { const el = ev.target.closest("[data-action-change=consult-filter]"); if (el) C.go(`/dashboard/consultations?filter=${el.value}`); });

  function captureForm(presetPatient) {
    return `<div class="bento space-y-4"><div><h3 class="font-display text-lg font-semibold">New consultation</h3><p class="text-sm text-muted-foreground">Pick the patient, paste the transcript and extract a structured draft. Nothing reaches the record until a clinician signs.</p></div>
      <form data-form="extract" class="space-y-4" novalidate><div id="extract-error"></div>${field("Patient", C.patientPicker("nc", presetPatient, "Search patients…"), "Search by name, phone or e-mail.")}
      ${field("Transcript", `<textarea id="nc-transcript" name="transcript" class="input min-h-[16rem]" maxlength="40000" placeholder="Paste the consultation transcript…"></textarea>`, `<span class="flex justify-between"><span>At least 20 characters.</span><span id="nc-count" class="font-mono">0 / 40,000</span></span>`, "nc-transcript")}
      <div class="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between"><button type="button" class="btn btn-outline" data-action="rec-start" title="Record and transcribe (simulated in the prototype)">${icon("mic")} Dictate</button><button type="submit" class="btn btn-primary" id="nc-submit" disabled>${icon("sparkles")} Extract clinical data</button></div></form></div>`;
  }
  function wireCapture() {
    const ta = document.querySelector("#nc-transcript"); if (!ta) return;
    const btn = document.querySelector("#nc-submit"), count = document.querySelector("#nc-count");
    const refresh = () => { const pid = (document.querySelector("#nc-id") || {}).value; count.textContent = `${ta.value.length.toLocaleString("en-US")} / 40,000`; btn.disabled = !(pid && ta.value.trim().length >= 20); };
    ta.addEventListener("input", refresh); document.addEventListener("picker-change", refresh); refresh();
  }
  C.forms.extract = (d, form) => {
    const box = form.querySelector("#extract-error");
    if (!d.patientId) { box.innerHTML = alert("Pick a patient first."); return; }
    if ((d.transcript || "").trim().length < 20) { box.innerHTML = alert("The transcript needs at least 20 characters."); return; }
    const u = C.currentUser(); const ex = extract(d.transcript);
    const c = { id: C.newId("con"), tenantId: C.tid(), patientId: d.patientId, doctorId: u.id, status: "PENDING_REVIEW", createdAt: new Date().toISOString(), reviewedAt: null, reviewedById: null, visitId: null, transcript: d.transcript, draft: { symptoms: ex.symptoms, diagnoses: ex.diagnoses, tests: ex.tests, followUps: ex.followUps, medications: ex.medications }, summary: ex.summary, empty: ex.empty, editedByClinician: false, provider: "prototype" };
    C.S.consultations.push(c); C.S.aiAsked = (C.S.aiAsked || 0) + 1; C.logAudit("consultation.extract", "Consultation", c.id); C.save();
    C.toast(ex.empty ? { title: "No structured data could be extracted", description: "The review starts blank — enter the findings before signing.", tone: "info" } : { title: "Draft extracted", description: "Review every section, then sign." });
    C.go(`/dashboard/consultations?open=${c.id}`);
  };

  function edit(c) { if (!edits[c.id]) edits[c.id] = { ...JSON.parse(JSON.stringify(c.draft)), summary: c.summary, stop: [] }; return edits[c.id]; }
  const chips = (key, items, editable, placeholder) => `<div class="rounded-lg border border-border p-3"><div class="flex flex-wrap gap-1.5">${items.length ? items.map((it, i) => `<span class="chip">${esc(it)}${editable ? `<button type="button" class="ml-0.5 text-accent/70 hover:text-accent" data-action="chip-remove" data-key="${key}" data-index="${i}" aria-label="Remove ${esc(it)}">${icon("x", "h-3 w-3")}</button>` : ""}</span>`).join("") : `<span class="text-sm text-muted-foreground">None.</span>`}</div>${editable ? `<form class="mt-2 flex gap-2" data-form="chip-add"><input type="hidden" name="key" value="${key}"><input name="value" class="input h-9" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}"><button class="btn btn-outline btn-sm" type="submit">${icon("plus")} Add</button></form>` : ""}</div>`;
  function reviewPanel(c, canSign) {
    const p = C.patient(c.patientId), author = C.user(c.doctorId), me = C.currentUser();
    if (C.lastSign && C.lastSign.id === c.id) { const o = C.lastSign.result; return `<div class="bento space-y-4"><div class="flex items-start gap-3"><span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-success/10 text-success">${icon("shield", "h-5 w-5")}</span><div><h3 class="font-display text-lg font-semibold">Signed into ${esc(p.fullName)}'s record</h3><p class="text-sm text-muted-foreground">${c.editedByClinician ? "You edited the AI draft before signing; the draft and the signed version are both in the audit log." : "The untouched draft was signed; it is in the audit log next to the signed version."}</p></div></div><div class="grid grid-cols-1 gap-4 sm:grid-cols-2">${[["Diagnoses added", o.addedDiagnoses, "None new — existing diagnoses kept."], ["Medications started", o.started, "None"], ["Medications adjusted", o.adjusted, "None"], ["Medications stopped", o.stopped, "None"]].map(([l, items, e]) => `<div><p class="data-label mb-1">${l}</p>${items.length ? `<ul class="text-sm">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : `<p class="text-sm text-muted-foreground">${e}</p>`}</div>`).join("")}</div>${o.continued.length ? `<p class="text-xs text-muted-foreground">Continued unchanged: ${esc(o.continued.join(", "))}</p>` : ""}<div class="flex flex-wrap gap-2 border-t border-border pt-4"><a class="btn btn-primary" href="#/dashboard/patients/${p.id}?tab=timeline">Open patient record</a><a class="btn btn-outline" href="#/dashboard/consultations">New consultation</a></div></div>`; }
    const header = `<div class="flex items-start justify-between gap-3"><div><h3 class="font-display text-lg font-semibold">${c.status === "SIGNED" ? "Signed consultation" : c.status === "DISCARDED" ? "Discarded draft" : canSign ? "Review & sign" : "Draft awaiting review"}</h3><p class="text-sm text-muted-foreground">${esc(p.fullName)} · captured ${fmtDate(c.createdAt)} ${fmtTime(c.createdAt)} by ${esc(author ? author.fullName : "")}${c.status === "PENDING_REVIEW" && canSign ? " — every section is editable. Nothing is saved until you sign." : ""}</p></div>${c.status === "PENDING_REVIEW" && canSign ? badge(edits[c.id] && JSON.stringify({ ...edits[c.id], stop: undefined, summary: undefined }) !== JSON.stringify({ ...c.draft }) ? "edited" : "matches AI draft", "accent") : badge(CLABEL[c.status], CTONE[c.status])}</div>`;
    const transcript = `<details class="rounded-lg border border-border"><summary class="cursor-pointer px-4 py-3 text-sm font-medium">Transcript</summary><pre class="whitespace-pre-wrap border-t border-border px-4 py-3 font-sans text-sm text-muted-foreground">${esc(c.transcript)}</pre></details>`;
    if (c.status !== "PENDING_REVIEW" || !canSign) {
      const d = c.draft;
      const ro = (label, items) => `<div><p class="data-label mb-1.5">${label}</p>${items.length ? `<div class="flex flex-wrap gap-1.5">${items.map((i) => `<span class="chip">${esc(i)}</span>`).join("")}</div>` : `<p class="text-sm text-muted-foreground">None.</p>`}</div>`;
      const canDiscard = c.status === "PENDING_REVIEW" && (canSign || c.doctorId === me.id);
      return `<div class="bento space-y-5">${header}${c.status === "PENDING_REVIEW" ? alert("Awaiting clinician review. Only a doctor or the clinic owner can sign this draft into the patient's record.", "info") : c.status === "SIGNED" && c.reviewedAt ? `<p class="text-sm text-muted-foreground">Signed ${fmtDate(c.reviewedAt)} ${fmtTime(c.reviewedAt)}${c.reviewedById && C.user(c.reviewedById) ? ` by ${esc(C.user(c.reviewedById).fullName)}` : ""}.</p>` : ""}
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">${ro("Symptoms", d.symptoms)}${ro("Diagnoses", d.diagnoses)}${ro("Tests ordered", d.tests)}${ro("Follow-ups", d.followUps)}</div>${ro("Medications", d.medications.map((m) => [m.name, m.dosage, m.frequency].filter(Boolean).join(" · ")))}
        <div><p class="data-label mb-1.5">Visit summary</p><p class="text-sm">${esc(c.summary || "—")}</p></div>${transcript}
        <div class="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4"><a class="btn btn-outline" href="#/dashboard/patients/${p.id}">Open patient record</a>${canDiscard ? `<button class="btn btn-ghost text-danger" data-action="consult-discard" data-id="${c.id}">${icon("trash")} Discard draft</button>` : ""}</div></div>`;
    }
    const e = edit(c);
    const active = C.medications().filter((m) => m.patientId === p.id && !m.stoppedAt);
    return `<div class="bento space-y-5" id="review-panel">${header}${c.empty && !e.symptoms.length && !e.diagnoses.length && !e.medications.length ? alert("No structured data could be extracted from this transcript. Nothing was inferred — enter the findings below before signing.", "info") : ""}
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2"><div><p class="data-label mb-1.5">Symptoms</p>${chips("symptoms", e.symptoms, true, "Add a symptom, press Enter")}</div><div><p class="data-label mb-1.5">Diagnoses</p>${chips("diagnoses", e.diagnoses, true, "Add a diagnosis, press Enter")}</div><div><p class="data-label mb-1.5">Tests ordered</p>${chips("tests", e.tests, true, "Add a test, press Enter")}</div><div><p class="data-label mb-1.5">Follow-ups</p>${chips("followUps", e.followUps, true, "Add a follow-up, press Enter")}</div></div>
      <div><p class="data-label mb-1.5">Medications</p>${e.medications.length ? `<div class="space-y-2"><div class="hidden grid-cols-[1fr_8rem_9rem_2rem] gap-2 sm:grid"><span class="data-label">Name</span><span class="data-label">Dosage</span><span class="data-label">Frequency</span><span></span></div>${e.medications.map((m, i) => `<div class="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_8rem_9rem_2rem]"><input class="input h-9" value="${esc(m.name)}" data-med="${i}" data-field="name" aria-label="Medication name"><input class="input h-9" value="${esc(m.dosage)}" data-med="${i}" data-field="dosage" aria-label="Dosage"><input class="input h-9" value="${esc(m.frequency)}" data-med="${i}" data-field="frequency" aria-label="Frequency"><button type="button" class="btn btn-ghost btn-icon text-danger" data-action="med-remove" data-index="${i}" aria-label="Remove medication">${icon("trash")}</button></div>`).join("")}</div>` : `<p class="text-sm text-muted-foreground">No medications in this consultation.</p>`}<button type="button" class="btn btn-outline btn-sm mt-2" data-action="med-add">${icon("plus")} Add medication</button></div>
      ${active.length ? `<div><p class="data-label mb-1.5">Stop existing medication</p><div class="divide-y divide-border rounded-lg border border-border">${active.map((m) => `<label class="flex items-center justify-between gap-3 px-3 py-2 text-sm"><span class="flex items-center gap-3"><input type="checkbox" class="h-4 w-4 rounded border-input text-accent" data-stop="${m.id}" ${e.stop.includes(m.id) ? "checked" : ""}><span><span class="font-medium">${esc(m.name)}</span> <span class="text-muted-foreground">· ${esc(m.dosage || "")} · ${esc(m.frequency || "")}</span><span class="block font-mono text-[10px] text-muted-foreground">since ${fmtDate(m.startedAt)}</span></span></span>${e.medications.some((x) => x.name.toLowerCase() === m.name.toLowerCase()) ? badge("in prescription", "accent") : ""}</label>`).join("")}</div><p class="mt-1 text-xs text-muted-foreground">Ticked medications are stopped when you sign. A current medication that also appears in the prescription above is updated in place — unless it is ticked, in which case the current entry is stopped and a fresh one started.</p></div>` : ""}
      <div><label class="data-label mb-1.5 block" for="rv-summary">Visit summary</label><textarea id="rv-summary" class="input min-h-[7rem]" maxlength="5000" placeholder="Summarise the visit for the record…">${esc(e.summary || "")}</textarea><p class="mt-1 flex justify-between text-xs text-muted-foreground"><span>Signed into the visit record.</span><span class="font-mono">${(e.summary || "").length} / 5,000</span></p></div>${transcript}
      <div class="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4"><button class="btn btn-ghost text-danger" data-action="consult-discard" data-id="${c.id}">${icon("trash")} Discard draft</button><button class="btn btn-primary" data-action="consult-sign" data-id="${c.id}">${icon("shield")} Review complete — sign</button></div></div>`;
  }
  function syncEdit(c) { const e = edit(c); document.querySelectorAll("[data-med]").forEach((inp) => { const m = e.medications[Number(inp.dataset.med)]; if (m) m[inp.dataset.field] = inp.value; }); const s = document.querySelector("#rv-summary"); if (s) e.summary = s.value; e.stop = [...document.querySelectorAll("[data-stop]:checked")].map((x) => x.dataset.stop); return e; }
  const openId = () => C.route().query.open;
  C.forms["chip-add"] = (d, form) => { const c = cons(openId()); const e = syncEdit(c); const v = (d.value || "").trim(); if (!v) return; if (!e[d.key].includes(v)) e[d.key].push(v); C.render(); };
  C.actions["chip-remove"] = (el) => { const c = cons(openId()); const e = syncEdit(c); e[el.dataset.key].splice(Number(el.dataset.index), 1); C.render(); };
  C.actions["med-add"] = () => { const c = cons(openId()); const e = syncEdit(c); e.medications.push({ name: "", dosage: "", frequency: "" }); C.render(); setTimeout(() => { const inputs = document.querySelectorAll('[data-field="name"]'); if (inputs.length) inputs[inputs.length - 1].focus(); }, 0); };
  C.actions["med-remove"] = (el) => { const c = cons(openId()); const e = syncEdit(c); e.medications.splice(Number(el.dataset.index), 1); C.render(); };
  C.actions["consult-discard"] = async (el) => { const c = cons(el.dataset.id); const ok = await C.confirmDialog({ title: "Discard this draft?", description: "The draft is kept for the audit trail but will never reach the patient record.", confirmLabel: "Discard draft", tone: "danger" }); if (!ok) return; c.status = "DISCARDED"; c.reviewedAt = new Date().toISOString(); c.reviewedById = C.currentUser().id; delete edits[c.id]; C.logAudit("consultation.discard", "Consultation", c.id); C.save(); C.toast({ title: "Draft discarded" }); C.go("/dashboard/consultations"); };
  C.actions["consult-sign"] = async (el) => {
    const c = cons(el.dataset.id); const e = syncEdit(c); const p = C.patient(c.patientId);
    e.medications = e.medications.filter((m) => m.name.trim());
    const blank = e.medications.filter((m) => !m.name.trim()).length;
    if (!e.symptoms.length && !e.diagnoses.length && !e.medications.length && !(e.summary || "").trim()) { C.toast({ title: "Nothing to sign", description: "Enter at least a diagnosis, a medication or a summary.", tone: "danger" }); return; }
    const ok = await C.confirmDialog({ title: "Sign this consultation?", description: `${e.diagnoses.length} diagnos${e.diagnoses.length === 1 ? "is" : "es"}, ${e.medications.length} medication${e.medications.length === 1 ? "" : "s"}${e.stop.length ? `, ${e.stop.length} to stop` : ""}${blank ? `, ${blank} empty row ignored` : ""}. This writes to ${p.fullName}'s record under your name and cannot be undone.`, confirmLabel: "Sign into record" });
    if (!ok) return;
    const me = C.currentUser(), now = new Date().toISOString();
    const result = { addedDiagnoses: [], started: [], adjusted: [], stopped: [], continued: [] };
    const v = { id: C.newId("vis"), tenantId: C.tid(), patientId: p.id, doctorId: c.doctorId, appointmentId: c.appointmentId || null, at: now, summary: (e.summary || "").trim(), diagnoses: e.diagnoses.slice(), symptoms: e.symptoms.slice(), tests: e.tests.slice(), followUps: e.followUps.slice(), medications: e.medications.map((m) => ({ ...m })) };
    C.S.visits.push(v);
    for (const d of e.diagnoses) if (!p.history.diagnoses.includes(d)) { p.history.diagnoses.push(d); result.addedDiagnoses.push(d); C.S.timeline.push({ id: C.newId("tl"), tenantId: C.tid(), patientId: p.id, kind: "DIAGNOSIS", at: now, title: d, body: "" }); }
    const active = C.S.medications.filter((m) => m.patientId === p.id && !m.stoppedAt);
    for (const id of e.stop) { const m = active.find((x) => x.id === id); if (m && !e.medications.some((x) => x.name.toLowerCase() === m.name.toLowerCase())) { m.stoppedAt = now; result.stopped.push(m.name); } }
    const prescribed = [];
    for (const m of e.medications) {
      const cur = active.find((x) => x.name.toLowerCase() === m.name.trim().toLowerCase());
      if (cur && !e.stop.includes(cur.id)) { if (cur.dosage !== m.dosage || cur.frequency !== m.frequency) { cur.dosage = m.dosage; cur.frequency = m.frequency; result.adjusted.push(m.name); prescribed.push(m.name); } else result.continued.push(m.name); }
      else { if (cur) { cur.stoppedAt = now; result.stopped.push(cur.name); } C.S.medications.push({ id: C.newId("med"), tenantId: C.tid(), patientId: p.id, name: m.name.trim(), dosage: m.dosage, frequency: m.frequency, startedAt: now, stoppedAt: null, visitId: v.id }); result.started.push(m.name); prescribed.push(m.name); }
    }
    if (prescribed.length) C.S.timeline.push({ id: C.newId("tl"), tenantId: C.tid(), patientId: p.id, kind: "PRESCRIPTION", at: now, title: prescribed.join(", "), body: "" });
    C.S.timeline.push({ id: C.newId("tl"), tenantId: C.tid(), patientId: p.id, kind: "VISIT", at: now, title: "Consultation signed", body: v.summary });
    if (c.appointmentId) { const a = aptOf(c.appointmentId); if (a && !["CANCELLED", "NO_SHOW"].includes(a.status)) a.status = "COMPLETED"; }
    c.editedByClinician = JSON.stringify({ ...e, stop: undefined, summary: undefined }) !== JSON.stringify({ ...c.draft });
    Object.assign(c, { status: "SIGNED", reviewedAt: now, reviewedById: me.id, visitId: v.id, signed: { symptoms: v.symptoms, diagnoses: v.diagnoses, tests: v.tests, followUps: v.followUps, medications: v.medications }, summary: v.summary });
    c.draft = { ...c.signed };
    delete edits[c.id];
    C.logAudit("consultation.sign", "Consultation", c.id, { visitId: v.id });
    C.save(); C.lastSign = { id: c.id, result };
    C.toast({ title: `Signed into ${p.fullName}'s record` });
    C.render();
  };

  // ── AI assistant ────────────────────────────────────────────────────────
  C.chat = { patientId: null, messages: [] };
  const STOP = new Set(["which", "what", "who", "whom", "whose", "the", "and", "for", "are", "is", "was", "were", "have", "has", "had", "with", "patient", "patients", "documented", "currently", "their", "there", "any", "all", "list", "show", "give", "about", "does", "did", "being", "been", "from", "into", "that", "this", "these", "those", "they", "them", "our", "your", "you", "please", "tell", "many", "much", "record", "records", "clinic", "treated", "treat", "treatment", "taking", "take", "takes", "being", "with", "how", "when", "where", "last", "recent", "summarise", "summarize", "summary", "far"]);
  const stem = (w) => w.replace(/ies$/, "y").replace(/(ses|xes|zes|ches|shes)$/, (m) => m.slice(0, -2)).replace(/s$/, "");
  const terms = (q) => [...new Set(q.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)).map(stem))];
  function docs(patientId) {
    const out = [];
    for (const p of C.patients().filter((x) => !x.archivedAt && (!patientId || x.id === patientId))) {
      const meds = C.medications().filter((m) => m.patientId === p.id && !m.stoppedAt);
      out.push({ kind: "profile", patient: p, heading: `${p.fullName} · Profile & medical history`, text: `Patient: ${p.fullName} (${C.age(p.dob)}-year-old ${p.gender.toLowerCase()}), preferred language: ${p.language}. Tags: ${p.tags.join(", ") || "none"}. Chronic conditions: ${p.history.chronicConditions.join("; ") || "none recorded"}. Allergies: ${p.history.allergies.join("; ") || "none recorded"}. Surgeries: ${p.history.surgeries.join("; ") || "none recorded"}. Diagnoses: ${p.history.diagnoses.join("; ") || "none recorded"}. Current medications: ${meds.map((m) => `${m.name} ${m.dosage} ${m.frequency}`).join("; ") || "none"}.` });
      for (const v of C.visits().filter((x) => x.patientId === p.id)) out.push({ kind: "visit", patient: p, heading: `${p.fullName} · Visit ${fmtDate(v.at)}`, text: `Visit on ${fmtDate(v.at)} with ${(C.user(v.doctorId) || {}).fullName || "the doctor"}: ${v.summary} Symptoms: ${(v.symptoms || []).join("; ")}. Tests ordered: ${(v.tests || []).join("; ") || "none"}.` });
      for (const cv of C.conversations().filter((x) => x.patientId === p.id)) out.push({ kind: "conversation", patient: p, heading: `${p.fullName} · WhatsApp ${fmtDate(cv.lastAt)}`, text: cv.messages.map((m) => `${m.direction === "INBOUND" ? "Patient" : "Clinic"}: ${m.body}`).join(" ") });
    }
    return out;
  }
  function answer(q, patientId) {
    const ts = terms(q); const all = docs(patientId);
    const p = patientId ? C.patient(patientId) : null;
    if (p && (/summar|overview|history|so far|tell me about/i.test(q) || !ts.length)) {
      const profile = all.find((d) => d.kind === "profile"), vis = C.visits().filter((v) => v.patientId === p.id).sort((a, b) => b.at.localeCompare(a.at));
      const facts = [`${profile.text} [1]`, vis.length ? `${vis.length} signed visit${vis.length === 1 ? "" : "s"}; the latest on ${fmtDate(vis[0].at)}: ${vis[0].summary} [2]` : "No signed visits on record."];
      const cites = [profile, vis.length ? all.find((d) => d.kind === "visit" && d.text.includes(fmtDate(vis[0].at))) : null].filter(Boolean);
      return { text: `Summary for ${p.fullName} from ${cites.length} record${cites.length === 1 ? "" : "s"}:\n\n${facts.map((f) => `• ${f}`).join("\n")}\n\nPrototype mode: the facts above are quoted from the cited records. The production assistant reasons over them with a live model and keeps the same citations.`, citations: cites, grounded: true };
    }
    const scored = all.map((d) => { const low = d.text.toLowerCase(); const hit = ts.filter((t) => low.includes(t)); return { d, score: hit.length, hit }; }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    const need = ts.length <= 2 ? ts.length : Math.ceil(ts.length * 0.6);
    const strong = scored.filter((x) => x.score >= need).slice(0, 6);
    if (!ts.length || !strong.length) return { text: `No matching records were found for "${q}". The clinic's indexed records do not contain information that answers this question, and ClinicMind does not answer clinical questions without matching records.`, citations: [], grounded: false };
    const bullets = strong.map((x, i) => { const sentences = x.d.text.split(/(?<=\.)\s+/).filter((s) => x.hit.some((t) => s.toLowerCase().includes(t))).slice(0, 3); return `• ${x.d.heading}: ${sentences.join(" ") || x.d.text.slice(0, 160)} [${i + 1}]`; });
    return { text: `Grounded summary for "${q}" from ${strong.length} matching record${strong.length === 1 ? "" : "s"}:\n\n${bullets.join("\n")}\n\nPrototype mode: the facts above are quoted from the cited records without further clinical reasoning. Verify against the chart before acting.`, citations: strong.map((x) => x.d), grounded: true };
  }
  C.views.assistant = () => {
    const can = C.can(C.currentUser().role, "ai:assistant");
    if (!can) return `<div class="space-y-6">${sectionTitle("AI Assistant", "Retrieval-grounded clinical chat over your clinic's records, with citations.")}${alert("Your role does not include the AI assistant. Ask the clinic owner if you need access.", "info")}</div>`;
    const p = C.chat.patientId ? C.patient(C.chat.patientId) : null;
    const suggestions = ["Which patients have a documented allergy to lidocaine or penicillin?", "Who is currently on isotretinoin, and at what dose?", "Which patients had an FUE hair transplant, and how many grafts?", "Who was treated for acne vulgaris and what was prescribed?"];
    const msgs = C.chat.messages;
    return `<div class="space-y-6">${sectionTitle("AI Assistant", "Retrieval-grounded clinical chat over your clinic's records, with citations.")}
      <div class="bento flex min-h-[70vh] flex-col p-0"><div class="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4"><div class="flex items-center gap-3"><span class="data-label">Patient context</span>${p ? `<span class="chip">${esc(p.fullName)}<button type="button" class="ml-1 text-accent/70 hover:text-accent" data-action="chat-clear-patient" aria-label="Clear patient context">${icon("x", "h-3 w-3")}</button></span>` : `<div class="w-64">${C.patientPicker("ai", null, "Search a patient to focus on…")}</div>`}</div><span class="text-xs text-muted-foreground">${p ? `Only ${esc(p.fullName)}'s records.` : "All of this clinic's records."}</span></div>
      <div class="flex-1 space-y-4 overflow-y-auto p-4" id="chat-log">${msgs.length ? msgs.map((m) => m.role === "user" ? `<div class="flex justify-end"><div class="max-w-[85%] rounded-lg bg-accent px-4 py-2 text-sm text-accent-foreground">${esc(m.text)}</div></div>` : `<div class="max-w-[85%] rounded-lg border border-border bg-card p-4 text-sm"><div class="whitespace-pre-wrap">${esc(m.text)}</div>${m.citations.length ? `<ol class="mt-4 space-y-2 border-t border-border pt-3">${m.citations.map((c, i) => `<li class="flex gap-2 text-xs">${icon("quote", "mt-0.5 h-3.5 w-3.5 shrink-0 text-accent")}<span><a href="#/dashboard/patients/${c.patient.id}" class="font-mono text-accent hover:underline">[${i + 1}]</a> <span class="font-mono uppercase text-muted-foreground">${c.kind}</span> · <a href="#/dashboard/patients/${c.patient.id}" class="font-medium hover:underline">${esc(c.heading)}</a> — <span class="text-muted-foreground">${esc(c.text.slice(0, 160))}…</span></span></li>`).join("")}</ol>` : ""}<div class="mt-3 flex gap-2">${m.grounded ? badge("grounded", "success") : badge("no matching records", "warning")}${badge("prototype")}</div></div>`).join("") : `<div class="flex h-full flex-col items-center justify-center py-10 text-center"><span class="flex h-12 w-12 items-center justify-center rounded-lg bg-accent text-accent-foreground">${icon("sparkles", "h-6 w-6")}</span><h3 class="mt-4 font-display text-lg font-semibold">Doctor AI Assistant</h3><p class="mt-1 max-w-md text-sm text-muted-foreground">Ask in natural language. Every answer is retrieved from this clinic's own records and cites the record it came from — when nothing matches, it says so.</p><div class="mt-6 grid w-full max-w-lg gap-2">${suggestions.map((s) => `<button class="rounded-lg border border-border bg-card px-4 py-2 text-left text-sm hover:bg-muted" data-action="chat-suggest" data-q="${esc(s)}">${esc(s)}</button>`).join("")}</div></div>`}</div>
      <form class="border-t border-border p-4" data-form="ask"><div class="flex gap-2"><input id="ask" name="q" class="input" placeholder="${p ? `Ask about ${esc(p.fullName)}…` : "Ask about patients, treatments, allergies, follow-ups…"}" autocomplete="off"><button class="btn btn-primary btn-icon" type="submit" aria-label="Send">${icon("send")}</button></div>${msgs.length ? `<div class="mt-2 flex flex-wrap gap-2">${suggestions.slice(0, 2).map((s) => `<button type="button" class="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted" data-action="chat-suggest" data-q="${esc(s)}">${esc(s)}</button>`).join("")}</div>` : ""}<p class="mt-2 text-xs text-muted-foreground">Decision support from this clinic's records; verify before acting.</p></form></div></div>`;
  };
  function ask(q) { q = (q || "").trim(); if (!q) return; C.chat.messages.push({ role: "user", text: q }); const a = answer(q, C.chat.patientId); C.chat.messages.push({ role: "assistant", ...a }); C.S.aiAsked = (C.S.aiAsked || 0) + 1; C.save(); C.render(); const log = document.querySelector("#chat-log"); if (log) log.scrollTop = log.scrollHeight; const i = document.querySelector("#ask"); if (i) i.focus(); }
  C.forms.ask = (d) => ask(d.q);
  C.actions["chat-suggest"] = (el) => ask(el.dataset.q);
  C.actions["chat-clear-patient"] = () => { C.chat.patientId = null; C.render(); };
  document.addEventListener("picker-change", (ev) => { if (ev.target && ev.target.id === "ai-picker" && ev.detail.patientId) { C.chat.patientId = ev.detail.patientId; C.render(); } });

  // ── Conversations ───────────────────────────────────────────────────────
  C.views.conversations = (r) => {
    const list = C.conversations().slice().sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    const open = r.query.open ? list.find((c) => c.id === r.query.open) : list[0];
    const thread = open ? `<div class="bento flex min-h-[60vh] flex-col p-0"><div class="flex items-center justify-between gap-3 border-b border-border p-4"><div class="flex items-center gap-3">${avatar(C.patient(open.patientId).fullName)}<div><a href="#/dashboard/patients/${open.patientId}" class="font-medium hover:underline">${esc(C.patient(open.patientId).fullName)}</a><p class="font-mono text-xs text-muted-foreground">${esc(C.patient(open.patientId).phone)} · WhatsApp</p></div></div><div class="flex items-center gap-2">${badge(open.status, open.status === "OPEN" ? "accent" : "default")}<button class="btn btn-outline btn-sm" data-action="conv-toggle" data-id="${open.id}">${open.status === "OPEN" ? "Close conversation" : "Reopen"}</button></div></div>
      <div class="flex-1 space-y-3 overflow-y-auto p-4">${open.messages.map((m) => `<div class="flex ${m.direction === "INBOUND" ? "justify-start" : "justify-end"}"><div class="max-w-[80%] rounded-lg px-3 py-2 text-sm ${m.direction === "INBOUND" ? "bg-muted" : "bg-accent text-accent-foreground"}"><p>${esc(m.body)}</p><p class="mt-1 font-mono text-[10px] ${m.direction === "INBOUND" ? "text-muted-foreground" : "text-accent-foreground/70"}">${fmtDate(m.at)} ${fmtTime(m.at)}${m.handledBy ? ` · ${m.handledBy === "ai" ? "AI draft, approved" : "staff"}` : ""}</p></div></div>`).join("")}</div>
      <form class="border-t border-border p-4" data-form="reply"><input type="hidden" name="id" value="${open.id}"><div class="flex gap-2"><input name="body" class="input" placeholder="Reply on WhatsApp…" autocomplete="off" ${open.status === "OPEN" ? "" : "disabled"}><button class="btn btn-primary btn-icon" type="submit" aria-label="Send" ${open.status === "OPEN" ? "" : "disabled"}>${icon("send")}</button></div><p class="mt-2 text-xs text-muted-foreground">Sent through Omni Grow, the all-in-one inbox. In the prototype the message is stored on the record only.</p></form></div>` : `<div class="bento">${emptyState("No conversations yet", "Messages arrive from the connected channels.")}</div>`;
    return `<div class="space-y-6">${sectionTitle("Conversations", "What the channels write into the patient record. The inbox itself is Omni Grow, integrated over a signed contract.", badge(`${list.filter((c) => c.status === "OPEN").length} open`, "accent"))}
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_1fr]"><div class="bento max-h-[70vh] self-start overflow-y-auto p-0"><ul class="divide-y divide-border">${list.map((c) => { const p = C.patient(c.patientId), last = c.messages[c.messages.length - 1]; return `<li><a href="#/dashboard/conversations?open=${c.id}" class="block px-4 py-3 hover:bg-muted/60 ${open && open.id === c.id ? "bg-accent-muted/60" : ""}"><span class="flex items-center justify-between gap-2"><span class="truncate text-sm font-medium">${esc(p.fullName)}</span><span class="font-mono text-[10px] text-muted-foreground">${fmtDate(c.lastAt).slice(0, 6)}</span></span><span class="mt-0.5 block truncate text-xs text-muted-foreground">${esc(last.body)}</span><span class="mt-1 flex gap-1">${badge("whatsapp", "success")}${c.status === "OPEN" ? badge("open", "accent") : ""}</span></a></li>`; }).join("")}</ul></div><div class="min-w-0">${thread}</div></div></div>`;
  };
  C.forms.reply = (d) => { const c = C.S.conversations.find((x) => x.id === d.id); if (!c || !(d.body || "").trim()) return; const now = new Date().toISOString(); c.messages.push({ id: C.newId("msg"), direction: "OUTBOUND", body: d.body.trim(), at: now, handledBy: "staff" }); c.lastAt = now; C.S.timeline.push({ id: C.newId("tl"), tenantId: C.tid(), patientId: c.patientId, kind: "CONVERSATION", at: now, title: "WhatsApp reply sent", body: d.body.trim() }); C.logAudit("conversation.reply", "Conversation", c.id); C.save(); C.render(); };
  C.actions["conv-toggle"] = (el) => { const c = C.S.conversations.find((x) => x.id === el.dataset.id); c.status = c.status === "OPEN" ? "CLOSED" : "OPEN"; C.save(); C.toast({ title: c.status === "OPEN" ? "Conversation reopened" : "Conversation closed" }); C.render(); };

  // Hooks run after every render.
  const prev = C.views.afterRender;
  C.views.afterRender = (r) => { if (prev) prev(r); C.mountPickers(); wireCapture(); };
})();
